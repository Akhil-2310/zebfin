//! Payment requests and their lifecycle.
//!
//! 1. `POST /accounts/{id}/payments` records a *request* (recipients, amounts,
//!    memos). The server checks it against the spending policy and that it's
//!    affordable, and stores it on the wallet side. Status `pending_approval`.
//! 2. Approvers approve the request's content hash with a passkey. Approvals
//!    don't expire with any transaction. Status `approved` at the threshold.
//! 3. `POST /payments/{id}/build` builds and proves the transaction, checking
//!    it pays exactly the approved recipients. Status `proving` ->
//!    `awaiting_signature`. If it expires before being signed, the payment
//!    returns to `approved` and is simply rebuilt.
//! 4. The approver's device signs; the server schedules a random broadcast
//!    moment. `scheduled` -> `sending` -> `broadcast` -> `mined`.
//!
//! Recipients, amounts and USD values live only in wallet-side files (the
//! future enclave), never in the app database.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use webauthn_rs::prelude::{PublicKeyCredential, RequestChallengeResponse};
use zebfin_wallet::{PcztSummary, Recipient, combine, parse_pczt, prove, serialize_pczt, summarize};

use super::{
    B64,
    accounts::owned_account,
    members::role_of,
    passkeys::{Pending, StartResponse, member_passkeys, record_use},
    policy::{approver_count, load_policy, payee_added_at},
};
use crate::{
    AppState,
    auth::{MemberAuth, OrgAuth},
    error::{ApiError, ApiResult},
    wallets::PcztStage,
};

const PENDING_APPROVAL: &str = "pending_approval";
const APPROVED: &str = "approved";
const PROVING: &str = "proving";
const AWAITING_SIGNATURE: &str = "awaiting_signature";
const SCHEDULED: &str = "scheduled";
const SENDING: &str = "sending";
const BROADCAST: &str = "broadcast";
const MINED: &str = "mined";
const FAILED: &str = "failed";
const CANCELLED: &str = "cancelled";

const KINDS: [&str; 5] = ["payroll", "payment", "refund", "transfer", "kudos"];

/// Every transaction's shielded action count is padded to a multiple of this,
/// hiding team size within buckets of 8.
const PAD_TO: usize = 8;
/// Target block spacing on testnet after NU7.
const BLOCK_SECS: i64 = 25;
/// Upper bound on the random broadcast delay.
const MAX_JITTER_SECS: i64 = 600;

/// Owner under which a payment's input notes are locked.
fn lock_owner(payment: Uuid) -> [u8; 32] {
    Sha256::new_with_prefix(b"zebfin/lock/v1").chain_update(payment.as_bytes()).finalize().into()
}

async fn release(state: &AppState, payment: Uuid, account_id: Uuid) {
    let owner = lock_owner(payment);
    if let Err(e) = state.wallets.with_wallet(account_id, move |w, _, _| w.release_locks(owner)).await {
        tracing::warn!("releasing locks for payment {payment}: {e:#}");
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecipientIn {
    pub address: String,
    pub value_zats: u64,
    pub memo: Option<String>,
}

/// The approved content of a payment, stored on the wallet side.
#[derive(Clone, Serialize, Deserialize)]
pub struct PaymentRequest {
    pub recipients: Vec<RecipientIn>,
    pub kind: String,
    pub usd_per_zec: Option<f64>,
    pub usd_value: Option<f64>,
    pub created_at: DateTime<Utc>,
}

impl PaymentRequest {
    /// What approvers approve: recipients, amounts and memos, in order.
    fn content_hash(&self) -> Vec<u8> {
        let canonical = serde_json::to_vec(&self.recipients).expect("serializable");
        Sha256::new_with_prefix(b"zebfin/request/v1|").chain_update(canonical).finalize().to_vec()
    }

    #[cfg(test)]
    fn total_zats(&self) -> u64 {
        self.recipients.iter().map(|r| r.value_zats).sum()
    }
}

#[derive(Deserialize)]
pub struct CreatePayment {
    pub recipients: Vec<RecipientIn>,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "payment".into()
}

#[derive(Serialize)]
pub struct Approval {
    pub member_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct Payment {
    pub id: Uuid,
    pub account_id: Uuid,
    pub kind: String,
    pub status: String,
    pub txid: Option<String>,
    pub mined_height: Option<u32>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub requested_by: Option<Uuid>,
    /// When a scheduled payment will be broadcast.
    pub broadcast_at: Option<DateTime<Utc>>,
    /// Hex SHA-256 of the request contents approvers approve.
    pub content_hash: String,
    /// The request's recipients, amounts and USD value (detail view only).
    pub request: Option<PaymentRequest>,
    /// What the built transaction does, decoded from the PCZT. The approver's
    /// device must recompute this itself from `pczt` rather than trusting it.
    pub summary: Option<PcztSummary>,
    /// The created (unsigned, unproven) PCZT for the approver to sign.
    pub pczt: Option<B64>,
    pub approvals: Vec<Approval>,
    pub approvals_required: i32,
}

type Row = (
    Uuid,
    Uuid,
    String,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<Vec<u8>>,
    String,
    Option<Uuid>,
);

const COLUMNS: &str =
    "id, account_id, status, txid, error, created_at, updated_at, broadcast_at, content_hash, kind, requested_by";

fn to_row(r: &tokio_postgres::Row) -> Row {
    (
        r.get(0),
        r.get(1),
        r.get(2),
        r.get(3),
        r.get(4),
        r.get(5),
        r.get(6),
        r.get(7),
        r.get(8),
        r.get(9),
        r.get(10),
    )
}

async fn load(state: &AppState, org: Uuid, id: Uuid) -> ApiResult<Row> {
    let row = state
        .db
        .get()
        .await?
        .query_opt(
            &format!("SELECT {COLUMNS} FROM payments WHERE id = $1 AND org_id = $2"),
            &[&id, &org],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(to_row(&row))
}

async fn set_status(state: &AppState, id: Uuid, status: &str, txid: Option<&str>, error: Option<&str>) {
    let r = async {
        state
            .db
            .get()
            .await?
            .execute(
                "UPDATE payments SET status = $2, txid = COALESCE($3, txid), error = $4,
                 updated_at = now() WHERE id = $1",
                &[&id, &status, &txid, &error],
            )
            .await?;
        Ok::<_, ApiError>(())
    }
    .await;
    if let Err(e) = r {
        tracing::error!("failed to update payment {id}: {e}");
    }
}

/// Moves a payment from one status to another only if it's still in `from`.
async fn transition(state: &AppState, id: Uuid, from: &[&str], to: &str) -> ApiResult<bool> {
    let from: Vec<String> = from.iter().map(|s| s.to_string()).collect();
    let n = state
        .db
        .get()
        .await?
        .execute(
            "UPDATE payments SET status = $2, error = NULL, updated_at = now() WHERE id = $1 AND status = ANY($3)",
            &[&id, &to, &from],
        )
        .await?;
    Ok(n == 1)
}

async fn read_request(state: &AppState, account_id: Uuid, id: Uuid) -> ApiResult<PaymentRequest> {
    let bytes = tokio::fs::read(state.wallets.request_path(account_id, id))
        .await
        .map_err(anyhow::Error::from)?;
    Ok(serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?)
}

/// Approvals that match the request's content, plus the number the current
/// policy requires for its USD value.
async fn approvals_for(
    state: &AppState,
    org: Uuid,
    id: Uuid,
    hash: &[u8],
    request: Option<&PaymentRequest>,
) -> ApiResult<(Vec<Approval>, i32)> {
    let rows = state
        .db
        .get()
        .await?
        .query(
            "SELECT member_id, created_at FROM approvals WHERE payment_id = $1 AND pczt_hash = $2 ORDER BY created_at",
            &[&id, &hash],
        )
        .await?;
    let policy = load_policy(state, org).await?;
    let approvers = approver_count(state, org).await?;
    let required = policy.required_approvals(request.and_then(|r| r.usd_value), approvers);
    Ok((
        rows.iter()
            .map(|r| Approval { member_id: r.get(0), created_at: r.get(1) })
            .collect(),
        required,
    ))
}

async fn render(state: &AppState, org: Uuid, row: Row, detail: bool) -> ApiResult<Payment> {
    let (id, account_id, mut status, txid, error, created_at, updated_at, broadcast_at, hash, kind, requested_by) = row;
    let hash = hash.unwrap_or_default();
    let request = read_request(state, account_id, id).await.ok();

    let created = if matches!(status.as_str(), PROVING | AWAITING_SIGNATURE | SCHEDULED | SENDING | BROADCAST | MINED) {
        tokio::fs::read(state.wallets.pczt_path(account_id, id, PcztStage::Created)).await.ok()
    } else {
        None
    };
    let summary = match &created {
        Some(bytes) => Some(summarize(parse_pczt(bytes)?)?.0),
        None => None,
    };

    // A built transaction that expired before being signed goes back to
    // `approved`: approvals cover the request, so it can just be rebuilt.
    if status == AWAITING_SIGNATURE {
        if let Some(s) = &summary {
            let tip = state.wallets.with_wallet(account_id, |w, _, _| w.chain_tip()).await?;
            if tip.is_some_and(|t| t + 1 >= s.expiry_height) && transition(state, id, &[AWAITING_SIGNATURE], APPROVED).await? {
                release(state, id, account_id).await;
                status = APPROVED.into();
            }
        }
    }

    let mut mined_height = None;
    if let Some(t) = txid.clone() {
        if status == BROADCAST || status == MINED {
            let h = state.wallets.with_wallet(account_id, move |w, _, _| w.tx_mined_height(&t)).await?;
            if let Some(Some(h)) = h {
                mined_height = Some(h);
                if status == BROADCAST {
                    set_status(state, id, MINED, None, None).await;
                    status = MINED.into();
                }
            }
        }
    }

    let (approvals, approvals_required) = approvals_for(state, org, id, &hash, request.as_ref()).await?;
    // Enough approvals (including after a policy change lowered the bar).
    if status == PENDING_APPROVAL && approvals.len() as i32 >= approvals_required && transition(state, id, &[PENDING_APPROVAL], APPROVED).await? {
        status = APPROVED.into();
    }
    let show_pczt = detail && status == AWAITING_SIGNATURE;
    Ok(Payment {
        id,
        account_id,
        kind,
        status,
        txid,
        mined_height,
        error,
        created_at,
        updated_at,
        requested_by,
        broadcast_at,
        content_hash: hex::encode(&hash),
        request: if detail { request } else { None },
        summary,
        pczt: if show_pczt { created.map(B64) } else { None },
        approvals,
        approvals_required,
    })
}

/// USD sent from an account since `since`, counting every request that hasn't
/// been cancelled or failed (pending ones too, to be conservative).
async fn spent_usd_since(state: &AppState, account_id: Uuid, since: DateTime<Utc>) -> ApiResult<f64> {
    let rows = state
        .db
        .get()
        .await?
        .query(
            "SELECT id FROM payments WHERE account_id = $1 AND created_at >= $2 AND status <> ALL($3)",
            &[&account_id, &since, &vec![CANCELLED.to_string(), FAILED.to_string()]],
        )
        .await?;
    let mut total = 0.0;
    for r in rows {
        if let Ok(req) = read_request(state, account_id, r.get(0)).await {
            total += req.usd_value.unwrap_or(0.0);
        }
    }
    Ok(total)
}

pub async fn create(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    member: Option<MemberAuth>,
    Path(account_id): Path<Uuid>,
    Json(body): Json<CreatePayment>,
) -> ApiResult<(StatusCode, Json<Payment>)> {
    owned_account(&state, org, account_id).await?;
    if body.recipients.is_empty() {
        return Err(ApiError::BadRequest("at least one recipient required".into()));
    }
    if !KINDS.contains(&body.kind.as_str()) {
        return Err(ApiError::BadRequest("unknown payment kind".into()));
    }

    // Valid, not to ourselves, and affordable right now.
    let recipients: Vec<Recipient> = body
        .recipients
        .iter()
        .map(|r| Recipient { address: r.address.clone(), value_zats: r.value_zats, memo: r.memo.clone() })
        .collect();
    state
        .wallets
        .with_wallet(account_id, move |w, _, _| w.check_payment(&recipients))
        .await
        .map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;

    let usd_per_zec = state.rates.current_usd_per_zec();
    let total: u64 = body.recipients.iter().map(|r| r.value_zats).sum();
    let usd_value = usd_per_zec.map(|rate| total as f64 / 1e8 * rate);
    let policy = load_policy(&state, org).await?;

    // Caps.
    if let (Some(v), Some(cap)) = (usd_value, policy.daily_cap_usd) {
        let spent = spent_usd_since(&state, account_id, Utc::now() - chrono::Duration::days(1)).await?;
        if spent + v > cap {
            return Err(ApiError::BadRequest(format!(
                "over the daily cap: ${:.2} already requested in 24h, cap ${cap:.2}",
                spent
            )));
        }
    }
    if let (Some(v), Some(cap)) = (usd_value, policy.monthly_cap_usd) {
        let spent = spent_usd_since(&state, account_id, Utc::now() - chrono::Duration::days(30)).await?;
        if spent + v > cap {
            return Err(ApiError::BadRequest(format!(
                "over the monthly cap: ${:.2} already requested in 30 days, cap ${cap:.2}",
                spent
            )));
        }
    }

    // Transfers must land in one of the org's own other accounts; they don't
    // leave the org, so the new-payee hold doesn't apply.
    let is_transfer = body.kind == "transfer";
    if is_transfer {
        let others: Vec<Uuid> = state
            .db
            .get()
            .await?
            .query("SELECT id FROM accounts WHERE org_id = $1 AND id <> $2", &[&org, &account_id])
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect();
        for r in &body.recipients {
            let mut owned = false;
            for other in &others {
                let a = r.address.clone();
                if state.wallets.with_wallet(*other, move |w, _, _| w.is_own_address(&a)).await? {
                    owned = true;
                    break;
                }
            }
            if !owned {
                return Err(ApiError::BadRequest("a transfer must go to another of this org's accounts".into()));
            }
        }
    }

    // New-payee hold: large payments only to payees in the book for long enough.
    let addresses: Vec<String> = if is_transfer { vec![] } else { body.recipients.iter().map(|r| r.address.clone()).collect() };
    let added = payee_added_at(&state, org, &addresses).await?;
    let hold = chrono::Duration::hours(policy.new_payee_hold_hours);
    for (r, at) in body.recipients.iter().zip(added) {
        // (empty for transfers)
        let usd = usd_per_zec.map(|rate| r.value_zats as f64 / 1e8 * rate);
        let large = usd.is_none_or(|v| v > policy.new_payee_hold_above_usd);
        let established = at.is_some_and(|t| Utc::now() - t >= hold);
        if large && !established {
            return Err(ApiError::BadRequest(format!(
                "{}… is a new payee: payments over ${:.0} to payees need them in the payee book for {}h first{}",
                &r.address[..r.address.len().min(14)],
                policy.new_payee_hold_above_usd,
                policy.new_payee_hold_hours,
                match at {
                    Some(t) => format!(" (added {})", t.format("%Y-%m-%d %H:%M UTC")),
                    None => " (not in the payee book)".into(),
                }
            )));
        }
    }

    let request = PaymentRequest {
        recipients: body.recipients,
        kind: body.kind.clone(),
        usd_per_zec,
        usd_value,
        created_at: Utc::now(),
    };
    let id = Uuid::new_v4();
    let hash = request.content_hash();
    state
        .wallets
        .write_pczt(&state.wallets.request_path(account_id, id), serde_json::to_vec(&request).map_err(anyhow::Error::from)?)
        .await?;
    let requested_by: Option<Uuid> = member.map(|m| m.member);
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO payments (id, org_id, account_id, status, content_hash, kind, requested_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
            &[&id, &org, &account_id, &PENDING_APPROVAL, &hash, &body.kind, &requested_by],
        )
        .await?;
    let row = load(&state, org, id).await?;
    Ok((StatusCode::CREATED, Json(render(&state, org, row, true).await?)))
}

/// Builds and proves the transaction for an approved request.
pub async fn build(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Payment>> {
    let row = load(&state, org, id).await?;
    let (_, account_id, status, ..) = &row;
    let account_id = *account_id;
    if status == PENDING_APPROVAL {
        promote_if_approved(&state, org, id, account_id).await?;
    }
    let (_, _, status, ..) = load(&state, org, id).await?;
    if status != APPROVED {
        return Err(ApiError::Conflict(format!("payment is {status}; only approved payments can be built")));
    }
    let request = read_request(&state, account_id, id).await?;
    let (approvals, required) = approvals_for(&state, org, id, &request.content_hash(), Some(&request)).await?;
    if (approvals.len() as i32) < required {
        return Err(ApiError::Conflict(format!("needs {required} approvals, has {}", approvals.len())));
    }
    if !transition(&state, id, &[APPROVED], PROVING).await? {
        return Err(ApiError::Conflict("payment changed state; try again".into()));
    }

    let recipients: Vec<Recipient> = request
        .recipients
        .iter()
        .map(|r| Recipient { address: r.address.clone(), value_zats: r.value_zats, memo: r.memo.clone() })
        .collect();
    let owner = lock_owner(id);
    let built = state
        .wallets
        .with_wallet(account_id, move |w, _, _| serialize_pczt(w.create_pczt(&recipients, Some(PAD_TO), owner)?))
        .await;
    let created = match built {
        Ok(c) => c,
        Err(e) => {
            transition(&state, id, &[PROVING], APPROVED).await?;
            return Err(ApiError::BadRequest(format!("{e:#}")));
        }
    };

    // The built transaction must pay exactly what was approved (padding aside).
    let summary = summarize(parse_pczt(&created)?)?.0;
    let mut paid: Vec<(String, u64)> = summary
        .payments
        .iter()
        .filter(|p| p.value_zats > 0)
        .map(|p| (p.address.clone().unwrap_or_default(), p.value_zats))
        .collect();
    let mut approved: Vec<(String, u64)> = request
        .recipients
        .iter()
        .filter(|r| r.value_zats > 0)
        .map(|r| (r.address.trim().to_string(), r.value_zats))
        .collect();
    paid.sort();
    approved.sort();
    if paid != approved {
        release(&state, id, account_id).await;
        transition(&state, id, &[PROVING], APPROVED).await?;
        return Err(ApiError::Internal(anyhow::anyhow!("built transaction does not match the approved request")));
    }

    state
        .wallets
        .write_pczt(&state.wallets.pczt_path(account_id, id, PcztStage::Created), created.clone())
        .await?;

    // Prove in the background; it takes several seconds of CPU.
    let bg = state.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || serialize_pczt(prove(parse_pczt(&created)?)?)).await;
        match result {
            Ok(Ok(proven)) => {
                let path = bg.wallets.pczt_path(account_id, id, PcztStage::Proven);
                match bg.wallets.write_pczt(&path, proven).await {
                    // Don't resurrect a payment cancelled while it was proving.
                    Ok(()) => drop(transition(&bg, id, &[PROVING], AWAITING_SIGNATURE).await),
                    Err(e) => set_status(&bg, id, FAILED, None, Some(&format!("store proof: {e}"))).await,
                }
            }
            Ok(Err(e)) => {
                tracing::error!("proving payment {id} failed: {e:#}");
                release(&bg, id, account_id).await;
                set_status(&bg, id, APPROVED, None, Some("proving failed; build again")).await
            }
            Err(e) => set_status(&bg, id, FAILED, None, Some(&format!("prover panicked: {e}"))).await,
        }
    });

    let row = load(&state, org, id).await?;
    Ok(Json(render(&state, org, row, true).await?))
}

pub async fn list(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(account_id): Path<Uuid>,
) -> ApiResult<Json<Vec<Payment>>> {
    owned_account(&state, org, account_id).await?;
    let rows = state
        .db
        .get()
        .await?
        .query(
            &format!("SELECT {COLUMNS} FROM payments WHERE account_id = $1 AND org_id = $2 ORDER BY created_at DESC"),
            &[&account_id, &org],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(render(&state, org, to_row(row), false).await?);
    }
    Ok(Json(out))
}

pub async fn get(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Payment>> {
    let row = load(&state, org, id).await?;
    Ok(Json(render(&state, org, row, true).await?))
}

#[derive(Deserialize)]
pub struct SubmitSignature {
    /// The created PCZT after the approver's device signed it.
    pub pczt: B64,
    /// Skip the randomized broadcast delay.
    #[serde(default)]
    pub send_now: bool,
}

/// Combines the proven and signed PCZTs and broadcasts the transaction.
async fn broadcast(state: &AppState, id: Uuid, account_id: Uuid) {
    let result = async {
        let proven = tokio::fs::read(state.wallets.pczt_path(account_id, id, PcztStage::Proven)).await?;
        let signed = tokio::fs::read(state.wallets.pczt_path(account_id, id, PcztStage::Signed)).await?;
        let combined = combine(parse_pczt(&proven)?, parse_pczt(&signed)?)?;
        state
            .wallets
            .with_wallet(account_id, move |w, rt, client| rt.block_on(w.send(client, combined)))
            .await
    }
    .await;
    match result {
        Ok(txid) => set_status(state, id, BROADCAST, Some(&txid), None).await,
        Err(e) => {
            tracing::error!("broadcast of payment {id} failed: {e:#}");
            release(state, id, account_id).await;
            if format!("{e:#}").contains("expiry") {
                // Still approved; it just needs a fresh transaction.
                set_status(state, id, APPROVED, None, Some("expired before broadcast; build again")).await;
            } else {
                set_status(state, id, FAILED, None, Some("broadcast failed")).await;
            }
        }
    }
}

/// Broadcasts scheduled payments when their random moment arrives.
pub async fn broadcast_loop(state: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tick.tick().await;
        let due = async {
            // Claim due payments atomically so each is sent once.
            let rows = state
                .db
                .get()
                .await?
                .query(
                    "UPDATE payments SET status = $1, updated_at = now()
                     WHERE status = $2 AND broadcast_at <= now() RETURNING id, account_id",
                    &[&SENDING, &SCHEDULED],
                )
                .await?;
            Ok::<_, ApiError>(rows.iter().map(|r| (r.get(0), r.get(1))).collect::<Vec<(Uuid, Uuid)>>())
        }
        .await;
        match due {
            Ok(due) => {
                for (id, account_id) in due {
                    broadcast(&state, id, account_id).await;
                }
            }
            Err(e) => tracing::warn!("broadcast loop: {e}"),
        }
    }
}

pub async fn submit_signature(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
    Json(body): Json<SubmitSignature>,
) -> ApiResult<Json<Payment>> {
    let row = load(&state, org, id).await?;
    let (_, account_id, status, ..) = &row;
    let account_id = *account_id;
    match status.as_str() {
        AWAITING_SIGNATURE => {}
        PROVING => return Err(ApiError::Conflict("still proving; retry shortly".into())),
        PENDING_APPROVAL | APPROVED => {
            return Err(ApiError::Conflict(format!("payment is {status}; it must be approved and built first")));
        }
        other => return Err(ApiError::Conflict(format!("payment is {other}"))),
    }

    let request = read_request(&state, account_id, id).await?;
    let (approvals, required) = approvals_for(&state, org, id, &request.content_hash(), Some(&request)).await?;
    if (approvals.len() as i32) < required {
        return Err(ApiError::Conflict(format!("needs {required} approvals, has {}", approvals.len())));
    }

    let signed = parse_pczt(&body.pczt.0).map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;
    let proven_bytes = tokio::fs::read(state.wallets.pczt_path(account_id, id, PcztStage::Proven))
        .await
        .map_err(anyhow::Error::from)?;
    // The combiner rejects a signed PCZT that doesn't match the one we built.
    combine(parse_pczt(&proven_bytes)?, signed)
        .map_err(|e| ApiError::BadRequest(format!("signature does not match this payment: {e:#}")))?;

    // Random broadcast moment, bounded by the transaction's standard 40-block
    // expiry (a longer one would itself be a fingerprint).
    let created = tokio::fs::read(state.wallets.pczt_path(account_id, id, PcztStage::Created))
        .await
        .map_err(anyhow::Error::from)?;
    let expiry = i64::from(summarize(parse_pczt(&created)?)?.0.expiry_height);
    let tip = state
        .wallets
        .with_wallet(account_id, |w, _, _| w.chain_tip())
        .await?
        .map(i64::from)
        .unwrap_or(expiry);
    if tip + 1 >= expiry {
        transition(&state, id, &[AWAITING_SIGNATURE], APPROVED).await?;
        release(&state, id, account_id).await;
        return Err(ApiError::Conflict("this transaction expired before it was signed; build it again".into()));
    }
    state
        .wallets
        .write_pczt(&state.wallets.pczt_path(account_id, id, PcztStage::Signed), body.pczt.0)
        .await?;
    let window = ((expiry - tip - 3) * BLOCK_SECS).min(MAX_JITTER_SECS);

    if body.send_now || window < 30 {
        if !transition(&state, id, &[AWAITING_SIGNATURE], SENDING).await? {
            return Err(ApiError::Conflict("payment changed state; try again".into()));
        }
        broadcast(&state, id, account_id).await;
    } else {
        let delay = rand::random_range(0..window);
        let n = state
            .db
            .get()
            .await?
            .execute(
                "UPDATE payments SET status = $2, broadcast_at = now() + make_interval(secs => $3::float8),
                 updated_at = now() WHERE id = $1 AND status = $4",
                &[&id, &SCHEDULED, &(delay as f64), &AWAITING_SIGNATURE],
            )
            .await?;
        if n != 1 {
            return Err(ApiError::Conflict("payment changed state; try again".into()));
        }
    }
    let row = load(&state, org, id).await?;
    Ok(Json(render(&state, org, row, false).await?))
}

/// Step 1 of approving: a passkey challenge for the signed-in approver.
pub async fn approve_start(
    State(state): State<AppState>,
    auth: MemberAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<StartResponse<RequestChallengeResponse>>> {
    let (_, _, status, ..) = load(&state, auth.org, id).await?;
    if !matches!(status.as_str(), PENDING_APPROVAL | APPROVED | PROVING | AWAITING_SIGNATURE) {
        return Err(ApiError::Conflict(format!("payment is {status}")));
    }
    let role = role_of(&state, auth.member).await?;
    if role != "admin" && role != "approver" {
        return Err(ApiError::Forbidden("only admins and approvers can approve".into()));
    }
    let passkeys = member_passkeys(&state, auth.member).await?;
    let (options, pk_auth) = state
        .passkeys
        .webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("webauthn: {e}")))?;
    let challenge_id = state.passkeys.stash(Pending::Approve { payment: id, member: auth.member, auth: pk_auth });
    Ok(Json(StartResponse { challenge_id, org_id: Some(auth.org), member_id: Some(auth.member), options }))
}

#[derive(Deserialize)]
pub struct ApproveFinish {
    pub challenge_id: Uuid,
    pub credential: PublicKeyCredential,
}

/// Step 2 of approving: verify the passkey assertion and record the approval
/// against the hash of the request's exact contents.
pub async fn approve_finish(
    State(state): State<AppState>,
    auth: MemberAuth,
    Path(id): Path<Uuid>,
    Json(body): Json<ApproveFinish>,
) -> ApiResult<Json<Payment>> {
    let Pending::Approve { payment, member, auth: pk_auth } = state.passkeys.take(body.challenge_id)? else {
        return Err(ApiError::BadRequest("wrong challenge type".into()));
    };
    if payment != id || member != auth.member {
        return Err(ApiError::Unauthorized);
    }
    let result = state
        .passkeys
        .webauthn
        .finish_passkey_authentication(&body.credential, &pk_auth)
        .map_err(|_| ApiError::Unauthorized)?;
    record_use(&state, member_passkeys(&state, member).await?, &result).await?;

    let (_, account_id, ..) = load(&state, auth.org, id).await?;
    let request = read_request(&state, account_id, id).await?;
    let hash = request.content_hash();
    state
        .db
        .get()
        .await?
        .execute(
            "INSERT INTO approvals (payment_id, member_id, pczt_hash) VALUES ($1, $2, $3)
             ON CONFLICT (payment_id, member_id) DO UPDATE SET pczt_hash = EXCLUDED.pczt_hash, created_at = now()",
            &[&id, &member, &hash],
        )
        .await?;
    promote_if_approved(&state, auth.org, id, account_id).await?;
    let row = load(&state, auth.org, id).await?;
    Ok(Json(render(&state, auth.org, row, true).await?))
}

/// `pending_approval` -> `approved` once the policy's threshold is met.
pub async fn promote_if_approved(state: &AppState, org: Uuid, id: Uuid, account_id: Uuid) -> ApiResult<()> {
    let request = read_request(state, account_id, id).await?;
    let (approvals, required) = approvals_for(state, org, id, &request.content_hash(), Some(&request)).await?;
    if approvals.len() as i32 >= required {
        transition(state, id, &[PENDING_APPROVAL], APPROVED).await?;
    }
    Ok(())
}

/// Cancels a payment that hasn't been signed yet and releases its notes.
pub async fn cancel(
    State(state): State<AppState>,
    OrgAuth(org): OrgAuth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Payment>> {
    let (_, account_id, status, ..) = load(&state, org, id).await?;
    let cancellable = [PENDING_APPROVAL, APPROVED, PROVING, AWAITING_SIGNATURE];
    if !cancellable.contains(&status.as_str()) {
        return Err(ApiError::Conflict(format!("payment is {status} and can't be cancelled")));
    }
    if !transition(&state, id, &cancellable, CANCELLED).await? {
        return Err(ApiError::Conflict("payment changed state; try again".into()));
    }
    release(&state, id, account_id).await;
    let row = load(&state, org, id).await?;
    Ok(Json(render(&state, org, row, false).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(recipients: Vec<RecipientIn>) -> PaymentRequest {
        PaymentRequest { recipients, kind: "payment".into(), usd_per_zec: None, usd_value: None, created_at: Utc::now() }
    }

    #[test]
    fn content_hash_covers_recipients_amounts_and_memos() {
        let a = RecipientIn { address: "utest1a".into(), value_zats: 100, memo: Some("x".into()) };
        let base = req(vec![a.clone()]).content_hash();
        assert_eq!(base, req(vec![a.clone()]).content_hash());
        assert_ne!(base, req(vec![RecipientIn { value_zats: 101, ..a.clone() }]).content_hash());
        assert_ne!(base, req(vec![RecipientIn { memo: Some("y".into()), ..a.clone() }]).content_hash());
        assert_ne!(base, req(vec![RecipientIn { address: "utest1b".into(), ..a.clone() }]).content_hash());
        assert_eq!(req(vec![a.clone(), a]).total_zats(), 200);
    }
}
