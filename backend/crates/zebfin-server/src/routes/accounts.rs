use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zebfin_wallet::{Balance, HistoryEntry, TxEntry};

use crate::{
    AppState,
    auth::{MemberAuth, OrgAuth},
    error::{ApiError, ApiResult},
};

/// Confirms the account belongs to the caller's org.
pub async fn owned_account(state: &AppState, org: Uuid, account_id: Uuid) -> ApiResult<()> {
    state
        .db
        .get()
        .await?
        .query_opt(
            "SELECT id FROM accounts WHERE id = $1 AND org_id = $2",
            &[&account_id, &org],
        )
        .await?
        .map(|_| ())
        .ok_or(ApiError::NotFound)
}

#[derive(Deserialize)]
pub struct ImportAccount {
    /// Orchard-only UFVK exported by an approver's device.
    pub ufvk: String,
    pub seed_fingerprint: String,
    pub account_index: u32,
    pub birthday: Option<u32>,
}

#[derive(Serialize)]
pub struct AccountRef {
    pub account_id: Uuid,
}

pub async fn import(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Json(body): Json<ImportAccount>,
) -> ApiResult<(StatusCode, Json<AccountRef>)> {
    let account_id = Uuid::new_v4();
    // The wallet-side account name is the random ID; the human name lives in
    // an encrypted record.
    let name = account_id.to_string();
    state
        .wallets
        .with_wallet(account_id, move |w, rt, client| {
            rt.block_on(w.import_account(
                client,
                &name,
                &body.ufvk,
                &body.seed_fingerprint,
                body.account_index,
                body.birthday,
            ))
        })
        .await
        .map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO accounts (id, org_id) VALUES ($1, $2)",
            &[&account_id, &org],
        )
        .await?;
    Ok((StatusCode::CREATED, Json(AccountRef { account_id })))
}

pub async fn list(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<Vec<AccountRef>>> {
    let rows = state
        .db
        .get()
        .await?
        .query(
            "SELECT id FROM accounts WHERE org_id = $1 ORDER BY created_at",
            &[&org],
        )
        .await?;
    Ok(Json(
        rows.iter()
            .map(|r| AccountRef { account_id: r.get(0) })
            .collect(),
    ))
}

pub async fn sync(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Balance>> {
    owned_account(&state, org, account_id).await?;
    let balance = state
        .wallets
        .with_wallet(account_id, |w, rt, client| {
            rt.block_on(w.sync(client))?;
            w.balance()
        })
        .await?;
    Ok(Json(balance))
}

pub async fn balance(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Balance>> {
    owned_account(&state, org, account_id).await?;
    Ok(Json(
        state
            .wallets
            .with_wallet(account_id, |w, _, _| w.balance())
            .await?,
    ))
}

#[derive(Serialize)]
pub struct NewAddress {
    pub address: String,
}

/// A fresh Orchard-only address, e.g. for one invoice or one contributor.
pub async fn new_address(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<NewAddress>> {
    owned_account(&state, org, account_id).await?;
    let address = state
        .wallets
        .with_wallet(account_id, |w, _, _| w.fresh_address())
        .await?;
    Ok(Json(NewAddress { address }))
}

pub async fn history(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Vec<HistoryEntry>>> {
    owned_account(&state, org, account_id).await?;
    Ok(Json(
        state
            .wallets
            .with_wallet(account_id, |w, _, _| w.history())
            .await?,
    ))
}

/// Per-transaction view of the account for the browser-side ledger.
pub async fn transactions(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Vec<TxEntry>>> {
    owned_account(&state, org, account_id).await?;
    Ok(Json(
        state
            .wallets
            .with_wallet(account_id, |w, _, _| w.transactions())
            .await?,
    ))
}

#[derive(Serialize)]
pub struct ViewingKey {
    pub ufvk: String,
}

/// The account's viewing key, for an admin to hand to an auditor. A UFVK
/// reveals the account's whole history and can't be revoked, so this is
/// admin-only and the caller must warn accordingly.
pub async fn viewing_key(
    State(state): State<AppState>,
    auth: MemberAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<ViewingKey>> {
    super::members::require_admin(&state, &auth).await?;
    owned_account(&state, auth.org, account_id).await?;
    let ufvk = state.wallets.with_wallet(account_id, |w, _, _| w.viewing_key()).await?;
    Ok(Json(ViewingKey { ufvk }))
}

/// The public, chain-level view of a transaction (for "what the public sees").
/// Requires a session so the server isn't an open lookup proxy.
pub async fn public_tx(
    State(state): State<AppState>,
    OrgAuth(_org): OrgAuth,
    Path(txid): Path<String>,
) -> ApiResult<Json<zebfin_wallet::PublicTx>> {
    if txid.len() != 64 || !txid.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest("txid must be 64 hex characters".into()));
    }
    let mut client = state.wallets.client();
    Ok(Json(
        zebfin_wallet::public_view(&mut client, &txid)
            .await
            .map_err(|e| ApiError::BadRequest(format!("{e:#}")))?,
    ))
}
