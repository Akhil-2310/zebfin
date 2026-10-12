//! Opaque encrypted records. The server stores, lists and deletes blobs by
//! random ID; it never learns what kind of record a blob is.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{B64, check_ciphertext};
use crate::{
    AppState,
    auth::OrgAuth,
    error::{ApiError, ApiResult},
};

#[derive(Serialize)]
pub struct Record {
    pub id: Uuid,
    pub ciphertext: B64,
    pub updated_at: DateTime<Utc>,
}

fn to_record(r: &tokio_postgres::Row) -> Record {
    Record {
        id: r.get(0),
        ciphertext: B64(r.get(1)),
        updated_at: r.get(2),
    }
}

/// Returns every record; the browser decrypts and filters locally.
pub async fn list(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<Vec<Record>>> {
    let rows = state
        .db
        .get()
        .await?
        .query(
            "SELECT id, ciphertext, updated_at FROM records WHERE org_id = $1 ORDER BY id",
            &[&org],
        )
        .await?;
    Ok(Json(rows.iter().map(to_record).collect()))
}

pub async fn get(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Record>> {
    let row = state
        .db
        .get()
        .await?
        .query_opt(
            "SELECT id, ciphertext, updated_at FROM records WHERE org_id = $1 AND id = $2",
            &[&org, &id],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_record(&row)))
}

#[derive(Deserialize)]
pub struct PutRecord {
    pub ciphertext: B64,
}

pub async fn put(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
    Json(body): Json<PutRecord>,
) -> ApiResult<StatusCode> {
    check_ciphertext(&body.ciphertext)?;
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO records (org_id, id, ciphertext) VALUES ($1, $2, $3)
             ON CONFLICT (org_id, id)
             DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()",
            &[&org, &id, &body.ciphertext.0],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state
        .db
        .get()
        .await?
        .execute("DELETE FROM records WHERE org_id = $1 AND id = $2", &[&org, &id])
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
