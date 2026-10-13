//! Members, roles, invites and the approval policy.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use webauthn_rs::prelude::*;

use super::{
    B64,
    passkeys::{Pending, SessionResponse, StartResponse, store_passkey},
};
use crate::{
    AppState,
    auth::{MemberAuth, create_session},
    error::{ApiError, ApiResult},
};

pub const ROLES: [&str; 3] = ["admin", "approver", "member"];

pub async fn role_of(state: &AppState, member: Uuid) -> ApiResult<String> {
    Ok(state
        .db
        .get()
        .await?
        .query_opt("SELECT role FROM members WHERE id = $1", &[&member])
        .await?
        .ok_or(ApiError::Unauthorized)?
        .get(0))
}

pub async fn require_admin(state: &AppState, auth: &MemberAuth) -> ApiResult<()> {
    if role_of(state, auth.member).await? != "admin" {
        return Err(ApiError::Forbidden("admins only".into()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Member {
    pub member_id: Uuid,
    pub role: String,
    pub is_me: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct Members {
    pub members: Vec<Member>,
    pub approval_threshold: i32,
}

pub async fn list(State(state): State<AppState>, auth: MemberAuth) -> ApiResult<Json<Members>> {
    let db = state.db.get().await?;
    let rows = db
        .query(
            "SELECT id, role, created_at FROM members WHERE org_id = $1 ORDER BY created_at",
            &[&auth.org],
        )
        .await?;
    // The smallest number of approvals any payment needs under the current policy.
    let approvers = super::policy::approver_count(&state, auth.org).await?;
    let threshold = super::policy::load_policy(&state, auth.org).await?.required_approvals(Some(0.0), approvers);
    Ok(Json(Members {
        members: rows
            .iter()
            .map(|r| Member {
                member_id: r.get(0),
                role: r.get(1),
                is_me: r.get::<_, Uuid>(0) == auth.member,
                created_at: r.get(2),
            })
            .collect(),
        approval_threshold: threshold,
    }))
}

#[derive(Deserialize)]
pub struct CreateInvite {
    pub role: String,
    /// 32 bytes derived in the browser from the invite secret.
    pub verifier: B64,
}

#[derive(Serialize)]
pub struct InviteRef {
    pub invite_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

pub async fn create_invite(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(body): Json<CreateInvite>,
) -> ApiResult<(StatusCode, Json<InviteRef>)> {
    require_admin(&state, &auth).await?;
    if !ROLES.contains(&body.role.as_str()) {
        return Err(ApiError::BadRequest("unknown role".into()));
    }
    if body.verifier.0.len() != 32 {
        return Err(ApiError::BadRequest("verifier must be 32 bytes".into()));
    }
    let id = Uuid::new_v4();
    let row = state
        .db
        .get()
        .await?
        .query_one(
            "INSERT INTO invites (id, org_id, role, verifier_hash, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING expires_at",
            &[&id, &auth.org, &body.role, &Sha256::digest(&body.verifier.0).to_vec(), &auth.member],
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(InviteRef {
            invite_id: id,
            expires_at: row.get(0),
        }),
    ))
}

#[derive(Deserialize)]
pub struct JoinStart {
    pub verifier: B64,
}

/// Step 1 of joining: prove knowledge of the invite secret, get passkey options.
pub async fn join_start(
    State(state): State<AppState>,
    Path(invite): Path<Uuid>,
    Json(body): Json<JoinStart>,
) -> ApiResult<Json<StartResponse<CreationChallengeResponse>>> {
    let row = state
        .db
        .get()
        .await?
        .query_opt(
            "SELECT org_id, role, verifier_hash FROM invites
             WHERE id = $1 AND used_by IS NULL AND expires_at > now()",
            &[&invite],
        )
        .await?
        .ok_or_else(|| ApiError::BadRequest("invite is invalid, used or expired".into()))?;
    let stored: Vec<u8> = row.get(2);
    if !ct_eq(&stored, &Sha256::digest(&body.verifier.0)) {
        return Err(ApiError::Unauthorized);
    }
    let (org, role): (Uuid, String) = (row.get(0), row.get(1));
    let member = Uuid::new_v4();
    let (options, reg) = state.passkeys.registration(member, None)?;
    let challenge_id = state.passkeys.stash(Pending::Join {
        org,
        member,
        invite,
        role,
        reg,
    });
    Ok(Json(StartResponse {
        challenge_id,
        org_id: Some(org),
        member_id: Some(member),
        options,
    }))
}

#[derive(Deserialize)]
pub struct JoinFinish {
    pub challenge_id: Uuid,
    pub credential: RegisterPublicKeyCredential,
}

/// Step 2 of joining: register the passkey, create the member, use up the invite.
pub async fn join_finish(
    State(state): State<AppState>,
    Path(invite): Path<Uuid>,
    Json(body): Json<JoinFinish>,
) -> ApiResult<(StatusCode, Json<SessionResponse>)> {
    let Pending::Join {
        org,
        member,
        invite: pending_invite,
        role,
        reg,
    } = state.passkeys.take(body.challenge_id)?
    else {
        return Err(ApiError::BadRequest("wrong challenge type".into()));
    };
    if pending_invite != invite {
        return Err(ApiError::BadRequest("challenge is for another invite".into()));
    }
    let passkey = state
        .passkeys
        .webauthn
        .finish_passkey_registration(&body.credential, &reg)
        .map_err(|e| ApiError::BadRequest(format!("passkey registration failed: {e}")))?;

    let mut db = state.db.get().await?;
    let tx = db.transaction().await?;
    tx.execute(
        "INSERT INTO members (id, org_id, role) VALUES ($1, $2, $3)",
        &[&member, &org, &role],
    )
    .await?;
    // Single use: fails if someone else redeemed the invite meanwhile.
    let used = tx
        .execute(
            "UPDATE invites SET used_by = $2 WHERE id = $1 AND used_by IS NULL AND expires_at > now()",
            &[&invite, &member],
        )
        .await?;
    if used != 1 {
        return Err(ApiError::Conflict("invite already used".into()));
    }
    store_passkey(&tx, member, &passkey).await?;
    tx.commit().await?;

    let token = create_session(&db, org, member).await?;
    Ok((
        StatusCode::CREATED,
        Json(SessionResponse {
            org_id: org,
            member_id: member,
            token,
        }),
    ))
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
