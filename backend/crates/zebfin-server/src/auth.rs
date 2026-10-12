//! Request authentication.
//!
//! Browsers authenticate with a passkey and receive a short-lived session
//! token (see `routes::passkeys`). Org-scoped dev tokens from `POST /v1/orgs`
//! still work for CLI testing. Only SHA-256 hashes of tokens are stored.

use axum::{
    extract::{FromRequestParts, OptionalFromRequestParts},
    http::request::Parts,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngExt;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{AppState, error::ApiError};

/// The org the caller is authenticated as.
pub struct OrgAuth(pub Uuid);

/// The org and member behind a passkey session.
pub struct MemberAuth {
    pub org: Uuid,
    pub member: Uuid,
}

pub fn new_token() -> (String, Vec<u8>) {
    let bytes: [u8; 32] = rand::rng().random();
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_token(&token);
    (token, hash)
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn bearer(parts: &Parts) -> Result<&str, ApiError> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)
}

async fn session(state: &AppState, token: &str) -> Result<Option<MemberAuth>, ApiError> {
    let row = state
        .db
        .get()
        .await?
        .query_opt(
            "SELECT org_id, member_id FROM sessions WHERE token_hash = $1 AND expires_at > now()",
            &[&hash_token(token)],
        )
        .await?;
    Ok(row.map(|r| MemberAuth {
        org: r.get(0),
        member: r.get(1),
    }))
}

impl FromRequestParts<AppState> for MemberAuth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        session(state, bearer(parts)?).await?.ok_or(ApiError::Unauthorized)
    }
}

/// The member behind the request if it carries a passkey session (dev tokens
/// have none).
impl OptionalFromRequestParts<AppState> for MemberAuth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Option<Self>, Self::Rejection> {
        match bearer(parts) {
            Ok(token) => session(state, token).await,
            Err(_) => Ok(None),
        }
    }
}

impl FromRequestParts<AppState> for OrgAuth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(parts)?;
        if let Some(m) = session(state, token).await? {
            return Ok(OrgAuth(m.org));
        }
        let row = state
            .db
            .get()
            .await?
            .query_opt(
                "SELECT org_id FROM api_tokens WHERE token_hash = $1",
                &[&hash_token(token)],
            )
            .await?;
        row.map(|r| OrgAuth(r.get(0))).ok_or(ApiError::Unauthorized)
    }
}

/// Issues a 12-hour session for a member.
pub async fn create_session(
    db: &deadpool_postgres::Object,
    org: Uuid,
    member: Uuid,
) -> Result<String, ApiError> {
    let (token, hash) = new_token();
    db.execute(
        "INSERT INTO sessions (token_hash, org_id, member_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '12 hours')",
        &[&hash, &org, &member],
    )
    .await?;
    Ok(token)
}
