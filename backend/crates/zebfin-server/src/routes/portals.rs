//! Contributor portals. Org members manage them with their session; the
//! contributor authenticates with a verifier derived from the link secret,
//! sent in the `x-portal-verifier` header (base64).

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{B64, check_ciphertext, members::ct_eq};
use crate::{
    AppState,
    auth::OrgAuth,
    error::{ApiError, ApiResult},
};

#[derive(Deserialize)]
pub struct CreatePortal {
    pub verifier: B64,
    pub card_ciphertext: B64,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// For time-limited portals (auditor packages).
    pub expires_in_days: Option<i32>,
}

fn default_kind() -> String {
    "contributor".into()
}

#[derive(Serialize)]
pub struct PortalRef {
    pub portal_id: Uuid,
}

pub async fn create(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Json(body): Json<CreatePortal>,
) -> ApiResult<(StatusCode, Json<PortalRef>)> {
    check_ciphertext(&body.card_ciphertext)?;
    if body.verifier.0.len() != 32 {
        return Err(ApiError::BadRequest("verifier must be 32 bytes".into()));
    }
    if !["contributor", "invoice", "audit", "auction"].contains(&body.kind.as_str()) {
        return Err(ApiError::BadRequest("unknown portal kind".into()));
    }
    if body.kind == "audit" && !body.expires_in_days.is_some_and(|d| (1..=90).contains(&d)) {
        return Err(ApiError::BadRequest("audit links must expire within 1–90 days".into()));
    }
    let id = Uuid::new_v4();
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO portals (id, org_id, verifier_hash, card_ciphertext, kind, expires_at)
             VALUES ($1, $2, $3, $4, $5,
                     CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)",
            &[
                &id,
                &org,
                &Sha256::digest(&body.verifier.0).to_vec(),
                &body.card_ciphertext.0,
                &body.kind,
                &body.expires_in_days,
            ],
        )
        .await?;
    Ok((StatusCode::CREATED, Json(PortalRef { portal_id: id })))
}

#[derive(Serialize)]
pub struct Item {
    pub id: Uuid,
    pub ciphertext: B64,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct PortalView {
    pub kind: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub card_ciphertext: B64,
    pub response_ciphertext: Option<B64>,
    pub response_at: Option<DateTime<Utc>>,
    pub items: Vec<Item>,
}

async fn view(state: &AppState, id: Uuid, where_org: Option<Uuid>, verifier: Option<&[u8]>) -> ApiResult<PortalView> {
    let db = state.db.get().await?;
    let row = db
        .query_opt(
            "SELECT org_id, verifier_hash, card_ciphertext, response_ciphertext, response_at, kind, expires_at
             FROM portals WHERE id = $1",
            &[&id],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    if let Some(org) = where_org {
        if row.get::<_, Uuid>(0) != org {
            return Err(ApiError::NotFound);
        }
    }
    let expires_at: Option<DateTime<Utc>> = row.get(6);
    if let Some(v) = verifier {
        if !ct_eq(&row.get::<_, Vec<u8>>(1), &Sha256::digest(v)) {
            return Err(ApiError::Unauthorized);
        }
        // Expired links stop working for their holder; the org can still see them.
        if expires_at.is_some_and(|t| t <= Utc::now()) {
            return Err(ApiError::Forbidden("this link has expired".into()));
        }
    }
    let items = db
        .query(
            "SELECT id, ciphertext, created_at FROM portal_items WHERE portal_id = $1 ORDER BY created_at DESC",
            &[&id],
        )
        .await?
        .iter()
        .map(|r| Item {
            id: r.get(0),
            ciphertext: B64(r.get(1)),
            created_at: r.get(2),
        })
        .collect();
    Ok(PortalView {
        kind: row.get(5),
        expires_at,
        card_ciphertext: B64(row.get(2)),
        response_ciphertext: row.get::<_, Option<Vec<u8>>>(3).map(B64),
        response_at: row.get(4),
        items,
    })
}

fn portal_verifier(headers: &HeaderMap) -> ApiResult<Vec<u8>> {
    headers
        .get("x-portal-verifier")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| STANDARD.decode(v).ok())
        .ok_or(ApiError::Unauthorized)
}

/// The contributor's view, authenticated by the link-derived verifier.
pub async fn contributor_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<PortalView>> {
    let v = portal_verifier(&headers)?;
    Ok(Json(view(&state, id, None, Some(&v)).await?))
}

#[derive(Deserialize)]
pub struct Respond {
    pub ciphertext: B64,
}

/// The contributor submits (or replaces) their encrypted payout address.
pub async fn contributor_respond(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<Respond>,
) -> ApiResult<StatusCode> {
    check_ciphertext(&body.ciphertext)?;
    let v = portal_verifier(&headers)?;
    if matches!(view(&state, id, None, Some(&v)).await?.kind.as_str(), "audit" | "auction") {
        return Err(ApiError::Forbidden("this link is read-only".into()));
    }
    state
        .db
        .get()
        .await?
        .execute(
            "UPDATE portals SET response_ciphertext = $2, response_at = now() WHERE id = $1",
            &[&id, &body.ciphertext.0],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The org's view of a portal (to read the contributor's response).
pub async fn org_get(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<PortalView>> {
    Ok(Json(view(&state, id, Some(org), None).await?))
}

#[derive(Deserialize)]
pub struct PutItem {
    pub ciphertext: B64,
}

/// The org posts an encrypted payslip to a contributor's portal.
pub async fn org_put_item(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path((id, item)): Path<(Uuid, Uuid)>,
    Json(body): Json<PutItem>,
) -> ApiResult<StatusCode> {
    check_ciphertext(&body.ciphertext)?;
    view(&state, id, Some(org), None).await?;
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO portal_items (portal_id, id, ciphertext) VALUES ($1, $2, $3)
             ON CONFLICT (portal_id, id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext",
            &[&id, &item, &body.ciphertext.0],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Closes a portal (e.g. when a contributor leaves). Their payslips stay in
/// their own wallet's memos.
pub async fn org_delete(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state
        .db
        .get()
        .await?
        .execute("DELETE FROM portals WHERE id = $1 AND org_id = $2", &[&id, &org])
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
