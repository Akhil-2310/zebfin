//! Testnet faucet: one click sends a little TAZ from Zebfin's own faucet wallet
//! to a fresh address of the org's account, so trying Zebfin doesn't start
//! with a trip to a public faucet.
//!
//! The faucet wallet is separate from every org. This is the only spending key
//! the server ever holds, it's testnet only, and it is enabled only when
//! ZEBFIN_FAUCET_KEY and ZEBFIN_FAUCET_ACCOUNT are set.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::Context;
use axum::{Json, extract::State};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zebfin_signer::{DeviceSigner, SignerKeyFile};
use zebfin_wallet::{Recipient, combine, parse_pczt, prove, serialize_pczt};

use super::accounts::owned_account;
use crate::{
    AppState,
    auth::OrgAuth,
    error::{ApiError, ApiResult},
};

const COOLDOWN: Duration = Duration::from_secs(3600);
/// Same padding as payroll, so a faucet payment looks like any other.
const PAD_TO: usize = 8;

pub struct Faucet {
    signer: DeviceSigner,
    /// The faucet's account in the wallet service (imported view-only like any other).
    account: Uuid,
    zats: u64,
    last: Mutex<HashMap<Uuid, Instant>>,
    /// One faucet transaction at a time, so concurrent requests don't race for notes.
    busy: tokio::sync::Mutex<()>,
}

impl Faucet {
    pub fn from_env() -> anyhow::Result<Option<Arc<Self>>> {
        let (Ok(key), Ok(account)) = (std::env::var("ZEBFIN_FAUCET_KEY"), std::env::var("ZEBFIN_FAUCET_ACCOUNT")) else {
            return Ok(None);
        };
        let file: SignerKeyFile = serde_json::from_str(&std::fs::read_to_string(&key).context("reading ZEBFIN_FAUCET_KEY")?)
            .context("parsing ZEBFIN_FAUCET_KEY")?;
        let taz: f64 = std::env::var("ZEBFIN_FAUCET_TAZ").ok().and_then(|v| v.parse().ok()).unwrap_or(0.02);
        Ok(Some(Arc::new(Self {
            // Refuses anything but a testnet key file.
            signer: DeviceSigner::from_key_file(&file)?,
            account: account.parse().context("ZEBFIN_FAUCET_ACCOUNT must be an account id")?,
            zats: (taz * 1e8).round() as u64,
            last: Mutex::new(HashMap::new()),
            busy: tokio::sync::Mutex::new(()),
        })))
    }

    fn wait(&self, org: Uuid) -> Option<Duration> {
        let last = self.last.lock().unwrap();
        last.get(&org).and_then(|t| COOLDOWN.checked_sub(t.elapsed()))
    }
}

#[derive(Serialize)]
pub struct FaucetStatus {
    enabled: bool,
    amount_zats: u64,
    /// Seconds until this org can ask again (0 = now).
    wait_secs: u64,
}

pub async fn status(State(state): State<AppState>, OrgAuth(org): OrgAuth) -> ApiResult<Json<FaucetStatus>> {
    Ok(Json(match &state.faucet {
        Some(f) => FaucetStatus { enabled: true, amount_zats: f.zats, wait_secs: f.wait(org).map_or(0, |d| d.as_secs()) },
        None => FaucetStatus { enabled: false, amount_zats: 0, wait_secs: 0 },
    }))
}

#[derive(Deserialize)]
pub struct Drip {
    account_id: Uuid,
}

#[derive(Serialize)]
pub struct Dripped {
    txid: String,
    amount_zats: u64,
}

pub async fn drip(State(state): State<AppState>, OrgAuth(org): OrgAuth, Json(body): Json<Drip>) -> ApiResult<Json<Dripped>> {
    let faucet = state.faucet.clone().ok_or_else(|| ApiError::BadRequest("The testnet faucet isn't enabled on this server".into()))?;
    owned_account(&state, org, body.account_id).await?;
    if body.account_id == faucet.account {
        return Err(ApiError::BadRequest("That's the faucet's own account".into()));
    }
    if let Some(d) = faucet.wait(org) {
        return Err(ApiError::Conflict(format!("Your org already got test TAZ recently. Try again in {} min.", d.as_secs() / 60 + 1)));
    }
    let _one_at_a_time = faucet.busy.lock().await;

    let address = state.wallets.with_wallet(body.account_id, |w, _, _| w.fresh_address()).await?;
    let nonce: [u8; 16] = rand::rng().random();
    let owner: [u8; 32] = Sha256::new_with_prefix(b"zebfin/faucet/v1").chain_update(nonce).finalize().into();
    let recipients = vec![Recipient { address, value_zats: faucet.zats, memo: Some("Zebfin testnet faucet".into()) }];

    let sent = async {
        let created = state
            .wallets
            .with_wallet(faucet.account, move |w, _, _| serialize_pczt(w.create_pczt(&recipients, Some(PAD_TO), owner)?))
            .await?;
        // Proving and signing are CPU-heavy; keep them off the async workers.
        let f = faucet.clone();
        let combined = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let proven = prove(parse_pczt(&created)?)?;
            let signed = f.signer.sign(parse_pczt(&created)?)?;
            combine(proven, signed)
        })
        .await
        .map_err(anyhow::Error::from)??;
        state
            .wallets
            .with_wallet(faucet.account, move |w, rt, client| rt.block_on(w.send(client, combined)))
            .await
    }
    .await;

    match sent {
        Ok(txid) => {
            faucet.last.lock().unwrap().insert(org, Instant::now());
            tracing::info!("faucet sent {} zats for org {org}", faucet.zats);
            Ok(Json(Dripped { txid, amount_zats: faucet.zats }))
        }
        Err(e) => {
            tracing::error!("faucet failed: {e:#}");
            let _ = state.wallets.with_wallet(faucet.account, move |w, _, _| w.release_locks(owner)).await;
            let msg = format!("{e:#}");
            Err(ApiError::Conflict(if msg.contains("nsufficient") {
                "The faucet is empty or its change is still confirming. Try again in a few minutes.".into()
            } else {
                "The faucet couldn't send right now. Try again in a minute.".into()
            }))
        }
    }
}
