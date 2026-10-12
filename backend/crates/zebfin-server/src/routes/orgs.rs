use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{B64, check_ciphertext};
use crate::{
    AppState,
    auth::{OrgAuth, new_token},
    error::{ApiError, ApiResult},
};

#[derive(Deserialize)]
pub struct CreateOrg {
    pub meta_ciphertext: B64,
}

#[derive(Serialize)]
pub struct CreatedOrg {
    pub org_id: Uuid,
    /// Shown once. Only its hash is stored.
    pub token: String,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateOrg>,
) -> ApiResult<(StatusCode, Json<CreatedOrg>)> {
    check_ciphertext(&body.meta_ciphertext)?;
    let org_id = Uuid::new_v4();
    let (token, hash) = new_token();
    let mut db = state.db.get().await?;
    let tx = db.transaction().await?;
    tx.execute(
        "INSERT INTO orgs (id, meta_ciphertext) VALUES ($1, $2)",
        &[&org_id, &body.meta_ciphertext.0],
    )
    .await?;
    tx.execute(
        "INSERT INTO api_tokens (token_hash, org_id) VALUES ($1, $2)",
        &[&hash, &org_id],
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(CreatedOrg { org_id, token })))
}

#[derive(Serialize, Deserialize)]
pub struct OrgMeta {
    pub org_id: Uuid,
    pub meta_ciphertext: B64,
}

pub async fn get(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<OrgMeta>> {
    let db = state.db.get().await?;
    let meta: Vec<u8> = db
        .query_opt("SELECT meta_ciphertext FROM orgs WHERE id = $1", &[&org])
        .await?
        .ok_or(ApiError::NotFound)?
        .get(0);
    Ok(Json(OrgMeta {
        org_id: org,
        meta_ciphertext: B64(meta),
    }))
}

pub async fn update(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Json(body): Json<CreateOrg>,
) -> ApiResult<StatusCode> {
    check_ciphertext(&body.meta_ciphertext)?;
    state
        .db
        .get()
        .await?
        .execute(
            "UPDATE orgs SET meta_ciphertext = $2 WHERE id = $1",
            &[&org, &body.meta_ciphertext.0],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct WrappedKey {
    pub member_id: Uuid,
    pub key_version: i32,
    pub ciphertext: B64,
}

pub async fn list_keys(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
) -> ApiResult<Json<Vec<WrappedKey>>> {
    let rows = state
        .db
        .get()
        .await?
        .query(
            "SELECT member_id, key_version, ciphertext FROM wrapped_keys
             WHERE org_id = $1 ORDER BY key_version DESC, member_id",
            &[&org],
        )
        .await?;
    Ok(Json(
        rows.iter()
            .map(|r| WrappedKey {
                member_id: r.get(0),
                key_version: r.get(1),
                ciphertext: B64(r.get(2)),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct PutKey {
    pub ciphertext: B64,
}

pub async fn put_key(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path((member_id, key_version)): Path<(Uuid, i32)>,
    Json(body): Json<PutKey>,
) -> ApiResult<StatusCode> {
    check_ciphertext(&body.ciphertext)?;
    if key_version < 1 {
        return Err(ApiError::BadRequest("key_version must be >= 1".into()));
    }
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO wrapped_keys (org_id, member_id, key_version, ciphertext)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (org_id, member_id, key_version)
             DO UPDATE SET ciphertext = EXCLUDED.ciphertext",
            &[&org, &member_id, &key_version, &body.ciphertext.0],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes all of a member's wrapped keys. The browser must also rotate the
/// org key and re-encrypt records so the member loses access going forward.
pub async fn delete_member_keys(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(member_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state
        .db
        .get()
        .await?
        .execute(
            "DELETE FROM wrapped_keys WHERE org_id = $1 AND member_id = $2",
            &[&org, &member_id],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
