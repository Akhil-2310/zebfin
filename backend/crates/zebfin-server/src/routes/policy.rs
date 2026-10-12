//! Spending policy and approved payees, enforced by the server.
//!
//! Until threshold signing (FROST), these rules are enforced here rather than
//! by cryptography: the server refuses to create, build or accept a signature
//! for a payment that breaks them.

use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{B64, members::require_admin};
use crate::{
    AppState,
    auth::{MemberAuth, OrgAuth},
    error::{ApiError, ApiResult},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tier {
    /// Applies to payments whose total exceeds this many USD.
    pub above_usd: f64,
    pub approvals: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Policy {
    /// Approval tiers by total USD value, lowest first.
    pub tiers: Vec<Tier>,
    /// Per-account caps on USD sent, counting payments that are approved or later.
    pub daily_cap_usd: Option<f64>,
    pub monthly_cap_usd: Option<f64>,
    /// Payments above this USD amount to a payee who isn't in the payee book,
    /// or was added less than `new_payee_hold_hours` ago, are refused.
    pub new_payee_hold_above_usd: f64,
    pub new_payee_hold_hours: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            tiers: vec![
                Tier { above_usd: 0.0, approvals: 2 },
                Tier { above_usd: 10_000.0, approvals: 3 },
            ],
            daily_cap_usd: None,
            monthly_cap_usd: None,
            new_payee_hold_above_usd: 500.0,
            new_payee_hold_hours: 24,
        }
    }
}

impl Policy {
    /// Approvals needed for a payment of `usd` (None = no rate available, so
    /// the strictest tier applies).
    pub fn required_approvals(&self, usd: Option<f64>) -> i32 {
        let strictest = self.tiers.iter().map(|t| t.approvals).max().unwrap_or(1);
        match usd {
            None => strictest,
            Some(v) => self
                .tiers
                .iter()
                .filter(|t| v > t.above_usd || (t.above_usd == 0.0 && v >= 0.0))
                .map(|t| t.approvals)
                .max()
                .unwrap_or(1)
                .max(1),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.tiers.is_empty() {
            return Err("at least one approval tier is required".into());
        }
        if self.tiers.iter().any(|t| t.approvals < 1 || t.approvals > 10 || t.above_usd < 0.0) {
            return Err("tiers need 1–10 approvals and a non-negative threshold".into());
        }
        if [self.daily_cap_usd, self.monthly_cap_usd].iter().flatten().any(|c| *c <= 0.0) {
            return Err("caps must be positive".into());
        }
        if self.new_payee_hold_hours < 0 || self.new_payee_hold_above_usd < 0.0 {
            return Err("hold settings must be non-negative".into());
        }
        Ok(())
    }
}

/// How the server identifies a payee without storing the address.
pub fn payee_hash(address: &str) -> Vec<u8> {
    Sha256::new_with_prefix(b"zebfin/payee/v1|").chain_update(address.trim().as_bytes()).finalize().to_vec()
}

pub async fn load_policy(state: &AppState, org: Uuid) -> ApiResult<Policy> {
    let row = state
        .db
        .get()
        .await?
        .query_one("SELECT policy FROM orgs WHERE id = $1", &[&org])
        .await?;
    Ok(row
        .get::<_, Option<String>>(0)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

/// When each of `addresses` entered the payee book (None = not in it).
pub async fn payee_added_at(state: &AppState, org: Uuid, addresses: &[String]) -> ApiResult<Vec<Option<DateTime<Utc>>>> {
    let db = state.db.get().await?;
    let mut out = Vec::with_capacity(addresses.len());
    for a in addresses {
        let row = db
            .query_opt(
                "SELECT added_at FROM payees WHERE org_id = $1 AND address_hash = $2",
                &[&org, &payee_hash(a)],
            )
            .await?;
        out.push(row.map(|r| r.get(0)));
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct PolicyView {
    pub policy: Policy,
    pub pending: Option<Policy>,
    pub pending_by: Option<Uuid>,
}

pub async fn get(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<PolicyView>> {
    let row = state
        .db
        .get()
        .await?
        .query_one("SELECT policy, pending_policy, pending_policy_by FROM orgs WHERE id = $1", &[&org])
        .await?;
    let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str(&s).ok());
    Ok(Json(PolicyView {
        policy: parse(row.get(0)).unwrap_or_default(),
        pending: parse(row.get(1)),
        pending_by: row.get(2),
    }))
}

/// Proposes a new policy. With a single admin it applies at once; otherwise a
/// second admin must confirm it, so one compromised admin can't raise limits.
pub async fn propose(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(p): Json<Policy>,
) -> ApiResult<Json<PolicyView>> {
    require_admin(&state, &auth).await?;
    p.validate().map_err(ApiError::BadRequest)?;
    let json = serde_json::to_string(&p).map_err(anyhow::Error::from)?;
    let db = state.db.get().await?;
    let admins: i64 = db
        .query_one("SELECT count(*) FROM members WHERE org_id = $1 AND role = 'admin'", &[&auth.org])
        .await?
        .get(0);
    if admins <= 1 {
        db.execute(
            "UPDATE orgs SET policy = $2, pending_policy = NULL, pending_policy_by = NULL WHERE id = $1",
            &[&auth.org, &json],
        )
        .await?;
    } else {
        db.execute(
            "UPDATE orgs SET pending_policy = $2, pending_policy_by = $3 WHERE id = $1",
            &[&auth.org, &json, &auth.member],
        )
        .await?;
    }
    get(State(state), OrgAuth(auth.org)).await
}

/// A second admin confirms the pending policy.
pub async fn confirm(State(state): State<AppState>, auth: MemberAuth) -> ApiResult<Json<PolicyView>> {
    require_admin(&state, &auth).await?;
    let db = state.db.get().await?;
    let row = db
        .query_one("SELECT pending_policy, pending_policy_by FROM orgs WHERE id = $1", &[&auth.org])
        .await?;
    let (pending, by): (Option<String>, Option<Uuid>) = (row.get(0), row.get(1));
    let Some(pending) = pending else {
        return Err(ApiError::Conflict("no pending policy change".into()));
    };
    if by == Some(auth.member) {
        return Err(ApiError::Forbidden("another admin must confirm your change".into()));
    }
    db.execute(
        "UPDATE orgs SET policy = $2, pending_policy = NULL, pending_policy_by = NULL WHERE id = $1",
        &[&auth.org, &pending],
    )
    .await?;
    get(State(state), OrgAuth(auth.org)).await
}

#[derive(Serialize)]
pub struct Payee {
    pub address_hash: B64,
    pub added_at: DateTime<Utc>,
}

pub async fn list_payees(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<Vec<Payee>>> {
    let rows = state
        .db
        .get()
        .await?
        .query("SELECT address_hash, added_at FROM payees WHERE org_id = $1 ORDER BY added_at", &[&org])
        .await?;
    Ok(Json(
        rows.iter()
            .map(|r| Payee { address_hash: B64(r.get(0)), added_at: r.get(1) })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct AddPayee {
    pub address: String,
}

/// Adds a payee. The server keeps only a salted hash of the address; the
/// browser keeps the label in an encrypted record.
pub async fn add_payee(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(body): Json<AddPayee>,
) -> ApiResult<(StatusCode, Json<Payee>)> {
    let role = super::members::role_of(&state, auth.member).await?;
    if role == "member" {
        return Err(ApiError::Forbidden("only admins and approvers can add payees".into()));
    }
    zebfin_signer::validate_payee(&body.address).map_err(|e| ApiError::BadRequest(format!("{e:#}")))?;
    let hash = payee_hash(&body.address);
    let row = state
        .db
        .get()
        .await?
        .query_one(
            "INSERT INTO payees (org_id, address_hash, added_by) VALUES ($1, $2, $3)
             ON CONFLICT (org_id, address_hash) DO UPDATE SET address_hash = EXCLUDED.address_hash
             RETURNING added_at",
            &[&auth.org, &hash, &auth.member],
        )
        .await?;
    Ok((StatusCode::CREATED, Json(Payee { address_hash: B64(hash), added_at: row.get(0) })))
}

pub async fn remove_payee(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(body): Json<AddPayee>,
) -> ApiResult<StatusCode> {
    require_admin(&state, &auth).await?;
    state
        .db
        .get()
        .await?
        .execute(
            "DELETE FROM payees WHERE org_id = $1 AND address_hash = $2",
            &[&auth.org, &payee_hash(&body.address)],
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_pick_the_strictest_matching_rule() {
        let p = Policy {
            tiers: vec![
                Tier { above_usd: 0.0, approvals: 1 },
                Tier { above_usd: 1_000.0, approvals: 2 },
                Tier { above_usd: 10_000.0, approvals: 3 },
            ],
            ..Policy::default()
        };
        assert_eq!(p.required_approvals(Some(5.0)), 1);
        assert_eq!(p.required_approvals(Some(1_000.0)), 1);
        assert_eq!(p.required_approvals(Some(1_000.01)), 2);
        assert_eq!(p.required_approvals(Some(25_000.0)), 3);
        assert_eq!(p.required_approvals(None), 3, "no rate means strictest");
    }

    #[test]
    fn default_keeps_two_person_rule() {
        assert_eq!(Policy::default().required_approvals(Some(1.0)), 2);
    }

    #[test]
    fn rejects_nonsense_policies() {
        assert!(Policy { tiers: vec![], ..Policy::default() }.validate().is_err());
        assert!(Policy { tiers: vec![Tier { above_usd: 0.0, approvals: 0 }], ..Policy::default() }.validate().is_err());
        assert!(Policy { daily_cap_usd: Some(-1.0), ..Policy::default() }.validate().is_err());
        assert!(Policy::default().validate().is_ok());
    }

    #[test]
    fn payee_hash_is_stable_and_trims() {
        assert_eq!(payee_hash("utest1abc"), payee_hash(" utest1abc\n"));
        assert_ne!(payee_hash("utest1abc"), payee_hash("utest1abd"));
    }
}
