//! Zebfin's backend view-only wallet.
//!
//! Holds an account's UFVK (never its spending key), keeps it synced against a
//! testnet lightwalletd-compatible server, hands out fresh Orchard-only
//! addresses, and builds, proves and broadcasts PCZTs that approvers sign on
//! their own devices. The flow follows the zcash-devtool PCZT walkthrough.

mod cache;

use std::{num::NonZeroUsize, path::Path};

use anyhow::{Context, anyhow, bail};
use pczt::{Pczt, roles::prover::Prover};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use serde::Serialize;
use tonic::transport::{Channel, ClientTlsConfig};
use tracing::info;
use zcash_client_backend::{
    data_api::{
        Account as _, AccountBirthday, AccountPurpose, WalletRead, WalletWrite, Zip32Derivation,
        chain::ChainState,
        wallet::{
            ConfirmationsPolicy, create_pczt_from_proposal,
            extract_and_store_transaction_from_pczt,
            LockRequest,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    wallet::{LockOwner, OvkPolicy},
};
use zcash_client_sqlite::{AccountUuid, WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_protocol::{
    ShieldedPool,
    consensus::{BlockHeight, NetworkUpgrade, Parameters},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zebfin_signer::{NETWORK, validate_payee};
use zip32::fingerprint::SeedFingerprint;
use zip321::{Payment, TransactionRequest};

pub use cache::MemBlockCache;
pub use zcash_client_backend;
pub use zebfin_signer::{PcztSummary, summarize};

pub type Db =
    WalletDb<rusqlite::Connection, zcash_protocol::consensus::Network, SystemClock, UnwrapErr<SysRng>>;

/// Default testnet light-client server (same as zcash-devtool's `zecrocks`).
pub const DEFAULT_SERVER: &str = "https://testnet.zec.rocks:443";

const SYNC_BATCH_SIZE: u32 = 10_000;

/// How long a built payment's input notes stay reserved: a little longer than
/// the standard 40-block transaction expiry.
const INPUT_LOCK_BLOCKS: u32 = 45;

pub async fn connect(server: &str) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
    // Several TLS backends are linked in; pick one explicitly. Ignore the error
    // if a provider was already installed by an earlier call.
    let _ = rustls::crypto::ring::default_provider().install_default();
    info!("Connecting to {server}");
    let uri: tonic::transport::Uri = server.parse().context("Invalid server URI")?;
    let mut channel = Channel::builder(uri.clone());
    if uri.scheme_str() == Some("https") {
        let tls = ClientTlsConfig::new()
            .domain_name(uri.host().unwrap_or_default().to_string())
            .assume_http2(true)
            .with_webpki_roots();
        channel = channel.tls_config(tls)?;
    }
    Ok(CompactTxStreamerClient::new(channel.connect().await?))
}

pub struct Wallet {
    db: Db,
    db_path: std::path::PathBuf,
}

/// One transaction from this account's point of view, for the ledger.
#[derive(Debug, Serialize)]
pub struct TxEntry {
    pub txid: String,
    pub mined_height: Option<u32>,
    /// Unix seconds of the block that mined it.
    pub block_time: Option<i64>,
    /// Net change to the account balance (negative for spends, fee included).
    pub delta_zats: i64,
    pub fee_zats: Option<u64>,
    pub expired_unmined: bool,
    pub outputs: Vec<HistoryEntry>,
}

/// One shielded output the wallet sent or received, with its decrypted memo.
#[derive(Debug, Serialize)]
pub struct HistoryEntry {
    pub txid: String,
    pub mined_height: Option<u32>,
    pub pool: &'static str,
    pub direction: &'static str,
    pub value_zats: u64,
    pub is_change: bool,
    pub memo: Option<String>,
    /// Recipient address for outputs this wallet sent.
    pub to_address: Option<String>,
}

/// One payee in a payment request.
#[derive(Debug, Clone)]
pub struct Recipient {
    pub address: String,
    pub value_zats: u64,
    pub memo: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Balance {
    pub chain_tip: u32,
    pub fully_scanned: Option<u32>,
    pub total_zats: u64,
    pub orchard_spendable_zats: u64,
    pub ironwood_spendable_zats: u64,
    pub pending_zats: u64,
}

impl Wallet {
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let db_path = dir.join("data.sqlite");
        let mut db = WalletDb::for_path(&db_path, NETWORK, SystemClock, UnwrapErr(SysRng))?;
        init_wallet_db(&mut db, None).map_err(|e| anyhow!("Wallet DB migration failed: {e:?}"))?;
        Ok(Self { db, db_path })
    }

    /// Imports an approver's account as view-only. The seed fingerprint and
    /// account index are recorded so PCZTs carry ZIP 32 derivation info that
    /// lets the approver's device find the right key.
    pub async fn import_account(
        &mut self,
        client: &mut CompactTxStreamerClient<Channel>,
        name: &str,
        ufvk: &str,
        seed_fingerprint_hex: &str,
        account_index: u32,
        birthday: Option<u32>,
    ) -> anyhow::Result<AccountUuid> {
        let ufvk = UnifiedFullViewingKey::decode(&NETWORK, ufvk)
            .map_err(|e| anyhow!("Invalid UFVK: {e}"))?;
        if ufvk.orchard().is_none() || ufvk.sapling().is_some() || ufvk.p2pkh().is_some() {
            bail!("Zebfin accounts must use an Orchard-only UFVK");
        }
        let fp: [u8; 32] = hex::decode(seed_fingerprint_hex)?
            .try_into()
            .map_err(|_| anyhow!("Seed fingerprint must be 32 bytes"))?;

        let tip: u32 = client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height
            .try_into()?;
        let birthday = account_birthday(
            client,
            BlockHeight::from(birthday.unwrap_or(tip.saturating_sub(100))),
            Some(BlockHeight::from(tip)),
        )
        .await?;

        let purpose = AccountPurpose::Spending {
            derivation: Some(Zip32Derivation::new(
                SeedFingerprint::from_bytes(fp),
                zip32::AccountId::try_from(account_index)
                    .map_err(|_| anyhow!("Invalid account index"))?,
            )),
        };
        let account = self
            .db
            .import_account_ufvk(name, &ufvk, &birthday, purpose, None)?;
        Ok(account.id())
    }

    pub fn account(&self) -> anyhow::Result<AccountUuid> {
        let ids = self.db.get_account_ids()?;
        match ids.as_slice() {
            [id] => Ok(*id),
            [] => bail!("No account in wallet; run `wallet import` first"),
            _ => bail!("Multiple accounts; account selection not wired up yet"),
        }
    }

    pub async fn sync(&mut self, client: &mut CompactTxStreamerClient<Channel>) -> anyhow::Result<()> {
        let cache = MemBlockCache::default();
        zcash_client_backend::sync::run(client, &NETWORK, &cache, &mut self.db, SYNC_BATCH_SIZE)
            .await
            .map_err(|e| anyhow!("Sync failed: {e}"))?;
        self.enhance(client).await
    }

    /// Compact blocks omit memos, so after scanning we fetch the full
    /// transactions the wallet asks for and decrypt them. This is what makes
    /// payslip memos readable by the recipient.
    ///
    /// Privacy: requesting a txid tells the server we care about it. Fine on
    /// testnet; production should fetch through our own node or Tor.
    async fn enhance(&mut self, client: &mut CompactTxStreamerClient<Channel>) -> anyhow::Result<()> {
        use std::collections::BTreeSet;
        use zcash_client_backend::data_api::{
            TransactionDataRequest, TransactionStatus, wallet::decrypt_and_store_transaction,
        };
        use zcash_primitives::transaction::Transaction;
        use zcash_protocol::consensus::BranchId;

        let tip = self
            .db
            .chain_height()?
            .ok_or_else(|| anyhow!("Chain height unknown"))?;
        let mut done = BTreeSet::new();
        loop {
            let pending: Vec<_> = self
                .db
                .transaction_data_requests()?
                .into_iter()
                .filter(|r| !done.contains(r))
                .collect();
            if pending.is_empty() {
                return Ok(());
            }
            for request in pending {
                let txid = match &request {
                    TransactionDataRequest::GetStatus(txid)
                    | TransactionDataRequest::Enhancement(txid) => *txid,
                    // Zebfin accounts have no transparent receivers.
                    TransactionDataRequest::TransactionsInvolvingAddress(_) => {
                        done.insert(request);
                        continue;
                    }
                };
                let fetched = match client
                    .get_transaction(service::TxFilter {
                        hash: txid.as_ref().to_vec(),
                        ..Default::default()
                    })
                    .await
                {
                    Ok(resp) => Some(resp.into_inner()),
                    Err(status) if status.code() == tonic::Code::NotFound => None,
                    Err(status) => return Err(status.into()),
                };
                match (fetched, &request) {
                    (None, _) => {
                        self.db
                            .set_transaction_status(txid, TransactionStatus::TxidNotRecognized)?;
                    }
                    (Some(raw), TransactionDataRequest::GetStatus(_)) => {
                        let status = match u32::try_from(raw.height) {
                            Ok(h) if h > 0 => TransactionStatus::Mined(BlockHeight::from(h)),
                            _ => TransactionStatus::NotInMainChain,
                        };
                        self.db.set_transaction_status(txid, status)?;
                    }
                    (Some(raw), _) => {
                        let mined = u32::try_from(raw.height)
                            .ok()
                            .filter(|h| *h > 0)
                            .map(BlockHeight::from);
                        let tx = Transaction::read(
                            &raw.data[..],
                            BranchId::for_height(&NETWORK, mined.unwrap_or(tip)),
                        )?;
                        decrypt_and_store_transaction(&NETWORK, &mut self.db, &tx, mined)?;
                    }
                }
                done.insert(request);
            }
        }
    }

    pub fn balance(&self) -> anyhow::Result<Balance> {
        let account = self.account()?;
        let summary = self
            .db
            .get_wallet_summary(ConfirmationsPolicy::default())?
            .ok_or_else(|| anyhow!("Wallet not synced yet"))?;
        let b = summary
            .account_balances()
            .get(&account)
            .ok_or_else(|| anyhow!("Account missing from wallet summary"))?;
        let spendable =
            b.orchard_balance().spendable_value() + b.ironwood_balance().spendable_value();
        Ok(Balance {
            chain_tip: summary.chain_tip_height().into(),
            fully_scanned: Some(summary.fully_scanned_height().into()),
            total_zats: b.total().into_u64(),
            orchard_spendable_zats: b.orchard_balance().spendable_value().into_u64(),
            ironwood_spendable_zats: b.ironwood_balance().spendable_value().into_u64(),
            pending_zats: b
                .total()
                .into_u64()
                .saturating_sub(spendable.map(|z| z.into_u64()).unwrap_or(0)),
        })
    }

    /// Every shielded output this wallet sent or received, newest first, with
    /// memos decrypted (sent memos via the outgoing viewing key).
    pub fn history(&self) -> anyhow::Result<Vec<HistoryEntry>> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut stmt = conn.prepare(
            "SELECT txid, tx_mined_height, output_pool, from_account_uuid IS NOT NULL,
                    to_account_uuid IS NOT NULL, value, is_change, memo, to_address
             FROM v_tx_outputs
             ORDER BY tx_mined_height IS NULL DESC, tx_mined_height DESC, transaction_id DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let mut txid: Vec<u8> = row.get(0)?;
            txid.reverse();
            let pool: i64 = row.get(2)?;
            let from_us: bool = row.get(3)?;
            let to_us: bool = row.get(4)?;
            let memo: Option<Vec<u8>> = row.get(7)?;
            Ok(HistoryEntry {
                txid: hex::encode(txid),
                mined_height: row.get(1)?,
                pool: match pool {
                    0 => "transparent",
                    2 => "sapling",
                    3 => "orchard",
                    _ => "ironwood",
                },
                direction: match (from_us, to_us) {
                    (true, true) => "internal",
                    (true, false) => "sent",
                    _ => "received",
                },
                value_zats: row.get::<_, i64>(5)? as u64,
                is_change: row.get(6)?,
                to_address: row.get(8)?,
                memo: memo.and_then(|bytes| {
                    MemoBytes::from_bytes(&bytes)
                        .ok()
                        .and_then(|m| Memo::try_from(m).ok())
                        .and_then(|m| match m {
                            Memo::Text(t) => Some(t.to_string()),
                            _ => None,
                        })
                }),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The account's Unified Full Viewing Key (Orchard-only).
    pub fn viewing_key(&self) -> anyhow::Result<String> {
        let account = self.db.get_account(self.account()?)?.ok_or_else(|| anyhow!("Account missing"))?;
        let ufvk = account.ufvk().ok_or_else(|| anyhow!("Account has no UFVK"))?;
        ufvk.encode(&NETWORK).map_err(|e| anyhow!("Failed to encode UFVK: {e:?}"))
    }

    /// Releases the notes a cancelled or failed payment had reserved.
    pub fn release_locks(&mut self, lock_owner: [u8; 32]) -> anyhow::Result<usize> {
        use zcash_client_backend::data_api::OutputLockStore;
        let account = self.account()?;
        let owner = LockOwner::new(lock_owner);
        let mut released = 0;
        for output in self.db.get_locked_outputs(account)? {
            if self.db.unlock_output(&output, owner)? {
                released += 1;
            }
        }
        Ok(released)
    }

    /// Every transaction touching this account, newest first, with its outputs.
    pub fn transactions(&self) -> anyhow::Result<Vec<TxEntry>> {
        let conn = rusqlite::Connection::open_with_flags(
            &self.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let mut stmt = conn.prepare(
            "SELECT txid, mined_height, block_time, account_balance_delta, fee_paid, expired_unmined
             FROM v_transactions
             ORDER BY mined_height IS NULL DESC, mined_height DESC",
        )?;
        let mut txs = stmt
            .query_map([], |row| {
                let mut txid: Vec<u8> = row.get(0)?;
                txid.reverse();
                Ok(TxEntry {
                    txid: hex::encode(txid),
                    mined_height: row.get(1)?,
                    block_time: row.get(2)?,
                    delta_zats: row.get(3)?,
                    fee_zats: row.get::<_, Option<i64>>(4)?.map(|f| f as u64),
                    expired_unmined: row.get::<_, Option<bool>>(5)?.unwrap_or(false),
                    outputs: vec![],
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut by_tx: std::collections::HashMap<String, Vec<HistoryEntry>> = Default::default();
        for h in self.history()? {
            by_tx.entry(h.txid.clone()).or_default().push(h);
        }
        for tx in &mut txs {
            tx.outputs = by_tx.remove(&tx.txid).unwrap_or_default();
        }
        Ok(txs)
    }

    /// The latest chain height this wallet has seen.
    pub fn chain_tip(&self) -> anyhow::Result<Option<u32>> {
        Ok(self.db.chain_height()?.map(u32::from))
    }

    /// The mined height of one of this wallet's transactions: `None` if the
    /// wallet doesn't know it, `Some(None)` if it is not yet mined.
    pub fn tx_mined_height(&self, txid_hex: &str) -> anyhow::Result<Option<Option<u32>>> {
        Ok(self
            .history()?
            .into_iter()
            .find(|e| e.txid == txid_hex)
            .map(|e| e.mined_height))
    }

    /// Whether `address` was derived from this account's keys, by any wallet.
    /// Checked cryptographically with the Orchard incoming viewing keys, so it
    /// also catches addresses this wallet database never generated.
    pub fn is_own_address(&self, address: &str) -> anyhow::Result<bool> {
        let Some(zcash_keys::address::Address::Unified(ua)) =
            zcash_keys::address::Address::decode(&NETWORK, address)
        else {
            return Ok(false);
        };
        let Some(addr) = ua.orchard() else {
            return Ok(false);
        };
        let account = self
            .db
            .get_account(self.account()?)?
            .ok_or_else(|| anyhow!("Account missing"))?;
        let Some(fvk) = account.ufvk().and_then(|k| k.orchard()) else {
            return Ok(false);
        };
        Ok([zip32::Scope::External, zip32::Scope::Internal]
            .into_iter()
            .any(|scope| fvk.to_ivk(scope).diversifier_index(addr).is_some()))
    }

    /// A fresh diversified address with only an Orchard receiver. Every call
    /// returns a new, unlinkable address (rule 4: no address reuse).
    pub fn fresh_address(&mut self) -> anyhow::Result<String> {
        let account = self.account()?;
        let (ua, _) = self
            .db
            .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)?
            .ok_or_else(|| anyhow!("Could not derive a new address"))?;
        Ok(ua.encode(&NETWORK))
    }

    /// Checks a payment request without building or locking anything: payees
    /// are valid shielded testnet addresses, none belongs to this account,
    /// memos fit, and the account's total balance (including change still
    /// confirming) covers it plus an estimated padded fee. The strict
    /// spendable-funds check happens when the transaction is built.
    pub fn check_payment(&mut self, recipients: &[Recipient]) -> anyhow::Result<()> {
        if recipients.is_empty() {
            bail!("No recipients");
        }
        for (i, r) in recipients.iter().enumerate() {
            if self.is_own_address(&r.address)? {
                bail!("Recipient {i} is one of this account's own addresses");
            }
            validate_payee(&r.address)?;
            if let Some(m) = r.memo.as_deref() {
                m.parse::<Memo>().map_err(|e| anyhow!("Invalid memo for recipient {i}: {e:?}"))?;
            }
        }
        let total: u64 = recipients.iter().map(|r| r.value_zats).sum();
        // ZIP 317: 5,000 zats per action; outputs + change + one input, padded to 8.
        let actions = (recipients.len() + 2).div_ceil(8) * 8;
        let fee = 5_000 * actions as u64;
        let have = self.balance()?.total_zats;
        if have < total + fee {
            bail!(
                "Can't pay this right now: Insufficient balance (have {have}, need {} including an estimated fee)",
                total + fee
            );
        }
        Ok(())
    }

    /// Builds an unproven, unsigned PCZT paying `recipients` from this account.
    ///
    /// With `pad_to: Some(n)`, zero-value outputs to fresh addresses of this
    /// account are added until the transaction's shielded action count is a
    /// multiple of `n`, so a 3-person and a 7-person run look the same on
    /// chain. Padding outputs are real encrypted outputs, so they are
    /// indistinguishable from payments and are charged ZIP 317 fees honestly.
    ///
    /// The chosen notes are locked under `lock_owner` until the transaction
    /// expires, or until [`Self::release_locks`] is called for that owner.
    pub fn create_pczt(
        &mut self,
        recipients: &[Recipient],
        pad_to: Option<usize>,
        lock_owner: [u8; 32],
    ) -> anyhow::Result<Pczt> {
        if recipients.is_empty() {
            bail!("No recipients");
        }
        let account = self.account()?;
        for (i, r) in recipients.iter().enumerate() {
            if self.is_own_address(&r.address)? {
                bail!(
                    "Recipient {i} is one of this account's own addresses; payroll would pay the treasury itself"
                );
            }
        }

        let mut payments = recipients
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let addr = validate_payee(&r.address)?;
                let memo = r
                    .memo
                    .as_deref()
                    .map(|m| m.parse::<Memo>().map(MemoBytes::from))
                    .transpose()
                    .map_err(|e| anyhow!("Invalid memo for recipient {i}: {e:?}"))?;
                Payment::new(addr, Some(Zatoshis::from_u64(r.value_zats)?), memo, None, None, vec![])
                    .map_err(|e| anyhow!("Invalid payment {i}: {e:?}"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        // Change returns to the newest Orchard-protocol pool: Ironwood once
        // NU6.3 is active (the Orchard pool no longer accepts new value), Orchard before.
        let tip = self
            .db
            .chain_height()?
            .ok_or_else(|| anyhow!("Wallet not synced yet"))?;
        let change_pool = if NETWORK.is_nu_active(NetworkUpgrade::Nu6_3, tip + 1) {
            ShieldedPool::Ironwood
        } else {
            ShieldedPool::Orchard
        };
        // A single change output keeps the transaction's shape predictable.
        let change_strategy = MultiOutputChangeStrategy::new(
            StandardFeeRule::Zip317,
            None,
            change_pool,
            DustOutputPolicy::default(),
            SplitPolicy::with_min_output_value(NonZeroUsize::new(1).unwrap(), Zatoshis::from_u64(10_000_000)?),
        );

        // Propose; if padding is requested, add padding outputs and re-propose
        // until the action count lands on the bucket. Extra outputs raise the
        // fee and can pull in another input, hence the loop. These trial
        // proposals don't lock anything.
        let mut attempts = 0;
        let propose = |db: &mut Db, payments: &[Payment], lock: Option<LockRequest>| {
            let request = TransactionRequest::new(payments.to_vec())
                .map_err(|e| anyhow!("Invalid request: {e:?}"))?;
            propose_transfer::<_, _, _, _, std::convert::Infallible>(
                db,
                &NETWORK,
                account,
                &GreedyInputSelector::new(),
                &change_strategy,
                request,
                ConfirmationsPolicy::default(),
                &SpendPolicy::default(),
                lock,
                None,
            )
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("Insufficient balance") {
                    anyhow!(
                        "Could not build proposal: {msg}. Spendable funds exclude change that is still \
                         confirming and notes reserved by other pending runs (cancel those to free them)."
                    )
                } else {
                    anyhow!("Could not build proposal: {msg}")
                }
            })
        };
        loop {
            let proposal = propose(&mut self.db, &payments, None)?;

            let Some(bucket) = pad_to.filter(|b| *b > 1) else { break };
            let actions = shielded_action_count(proposal.steps().first(), tip + 1)?;
            let missing = (bucket - actions % bucket) % bucket;
            if missing == 0 {
                break;
            }
            attempts += 1;
            if attempts > 4 {
                bail!("Could not pad transaction to a multiple of {bucket} actions");
            }
            for _ in 0..missing {
                let addr = self.fresh_address()?;
                let addr = validate_payee(&addr)?;
                payments.push(
                    Payment::new(addr, Some(Zatoshis::ZERO), None, None, None, vec![])
                        .map_err(|e| anyhow!("Invalid padding output: {e:?}"))?,
                );
            }
        }

        // The final proposal locks its notes so a second run built before this
        // one is mined can't pick the same notes (which would fail only at
        // broadcast, after approvers signed). The lock outlives the
        // transaction's 40-block expiry and then lapses on its own.
        let proposal = propose(
            &mut self.db,
            &payments,
            Some(LockRequest::new(LockOwner::new(lock_owner), INPUT_LOCK_BLOCKS)),
        )?;

        create_pczt_from_proposal::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut self.db,
            &NETWORK,
            &SystemClock,
            &mut UnwrapErr(SysRng),
            account,
            OvkPolicy::Sender,
            &proposal,
            None,
            zcash_primitives::transaction::builder::BundlePadding::DEFAULT,
        )
        .map_err(|e| anyhow!("Could not create PCZT: {e}"))
    }

    /// Extracts the final transaction from a proven + signed PCZT, stores it
    /// in the wallet and broadcasts it. Returns the txid.
    pub async fn send(
        &mut self,
        client: &mut CompactTxStreamerClient<Channel>,
        pczt: Pczt,
    ) -> anyhow::Result<String> {
        let prover = zcash_proofs::prover::LocalTxProver::bundled();
        let (spend_vk, output_vk) = prover.verifying_keys();
        let txid = extract_and_store_transaction_from_pczt::<_, ()>(
            &mut self.db,
            &SystemClock,
            &mut UnwrapErr(SysRng),
            pczt,
            Some((&spend_vk, &output_vk)),
            None,
        )
        .map_err(|e| anyhow!("Failed to extract transaction: {e:?}"))?;

        let tx = self
            .db
            .get_transaction(txid)?
            .ok_or_else(|| anyhow!("Transaction {txid} not stored"))?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data)?;
        let resp = client.send_transaction(raw).await?.into_inner();
        if resp.error_code != 0 {
            bail!("Broadcast rejected ({}): {}", resp.error_code, resp.error_message);
        }
        Ok(txid.to_string())
    }
}

/// Adds Orchard/Ironwood proofs. Needs no spending key, so it runs on the
/// backend and approvers' devices never do the heavy work.
pub fn prove(pczt: Pczt) -> anyhow::Result<Pczt> {
    if !pczt.sapling().spends().is_empty() || !pczt.sapling().outputs().is_empty() {
        bail!("Zebfin PCZTs must not contain Sapling data");
    }
    let raw_branch_id = *pczt.global().consensus_branch_id();
    let mut prover = Prover::new(pczt);
    let needs_orchard = prover.requires_orchard_proof();
    let needs_ironwood = prover.requires_ironwood_proof();
    if needs_orchard || needs_ironwood {
        let branch_id = zcash_protocol::consensus::BranchId::try_from(raw_branch_id)
            .map_err(|_| anyhow!("Unknown consensus branch ID"))?;
        let version = zcash_primitives::transaction::components::orchard::bundle_version_for_branch(
            branch_id,
            orchard::ValuePool::Orchard,
        )
        .ok_or_else(|| anyhow!("Branch {branch_id:?} does not support Orchard"))?;
        let pk = orchard::circuit::ProvingKey::build(version.circuit_version());
        if needs_orchard {
            prover = prover
                .create_orchard_proof(UnwrapErr(SysRng), &pk)
                .map_err(|e| anyhow!("Orchard proof failed: {e:?}"))?;
        }
        if needs_ironwood {
            prover = prover
                .create_ironwood_proof(UnwrapErr(SysRng), &pk)
                .map_err(|e| anyhow!("Ironwood proof failed: {e:?}"))?;
        }
    }
    Ok(prover.finish())
}

/// Combines the proven PCZT (from the backend) with the signed PCZT (from the
/// approver's device).
pub fn combine(proven: Pczt, signed: Pczt) -> anyhow::Result<Pczt> {
    pczt::roles::combiner::Combiner::new(vec![proven, signed])
        .combine()
        .map_err(|e| anyhow!("Failed to combine PCZTs: {e:?}"))
}

/// Builds the account birthday from the tree state just before `height`.
/// Note: fetching a tree state reveals the birthday height to the server.
async fn account_birthday(
    client: &mut CompactTxStreamerClient<Channel>,
    height: BlockHeight,
    recover_until: Option<BlockHeight>,
) -> anyhow::Result<AccountBirthday> {
    let sapling = NETWORK
        .activation_height(NetworkUpgrade::Sapling)
        .expect("testnet has Sapling");
    let height = height.max(sapling);
    if height == sapling {
        let block = client
            .get_block(service::BlockId {
                height: u64::from(height),
                ..Default::default()
            })
            .await?
            .into_inner();
        return Ok(AccountBirthday::from_parts(
            ChainState::empty(height.saturating_sub(1), block.prev_hash()),
            recover_until,
        ));
    }
    let treestate = client
        .get_tree_state(service::BlockId {
            height: u64::from(height) - 1,
            ..Default::default()
        })
        .await?
        .into_inner();
    AccountBirthday::from_treestate(treestate, recover_until)
        .map_err(|e| anyhow!("Invalid tree state: {e:?}"))
}

pub fn parse_pczt(bytes: &[u8]) -> anyhow::Result<Pczt> {
    Pczt::parse(bytes).map_err(|e| anyhow!("Failed to parse PCZT: {e:?}"))
}

pub fn serialize_pczt(pczt: Pczt) -> anyhow::Result<Vec<u8>> {
    pczt.serialize()
        .map_err(|e| anyhow!("Failed to serialize PCZT: {e:?}"))
}

/// Returns the server's chain tip and, if the server knows the transaction,
/// the height it was mined at (0 if it is only in the mempool).
pub async fn lookup_tx(
    client: &mut CompactTxStreamerClient<Channel>,
    txid_hex: &str,
) -> anyhow::Result<(u64, Option<u64>)> {
    let tip = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner()
        .height;
    let mut hash = hex::decode(txid_hex).context("txid must be hex")?;
    hash.reverse();
    let found = match client
        .get_transaction(service::TxFilter {
            hash,
            ..Default::default()
        })
        .await
    {
        Ok(resp) => Some(resp.into_inner().height),
        Err(status) if status.code() == tonic::Code::NotFound => None,
        Err(status) => {
            tracing::warn!("GetTransaction failed: {status}");
            None
        }
    };
    Ok((tip, found))
}

/// Shielded actions a proposal step will produce, using the library's own
/// per-bundle rules for the consensus branch at `target`. (Ironwood bundles
/// pair spends with outputs; the post-NU6.3 Orchard turnstile bundle doesn't.)
fn shielded_action_count<N>(
    step: &zcash_client_backend::proposal::Step<N>,
    target: BlockHeight,
) -> anyhow::Result<usize> {
    use zcash_primitives::transaction::components::orchard::bundle_version_for_branch;
    let branch = zcash_protocol::consensus::BranchId::for_height(&NETWORK, target);
    let mut total = 0;
    if let Some(v) = bundle_version_for_branch(branch, orchard::ValuePool::Orchard) {
        total += step
            .orchard_action_count(zcash_primitives::transaction::builder::BundlePadding::DEFAULT, v)
            .map_err(|e| anyhow!("orchard action count: {e}"))?;
    }
    if let Some(v) = bundle_version_for_branch(branch, orchard::ValuePool::Ironwood) {
        total += step
            .ironwood_action_count(step.ironwood_bundle_padding(), v)
            .map_err(|e| anyhow!("ironwood action count: {e}"))?;
    }
    Ok(total)
}

/// What anyone looking at the chain sees for a transaction: its shape, the
/// net value moving in or out of each shielded pool (normally just the fee),
/// and ciphertext. No addresses, amounts or memos.
#[derive(Debug, Serialize)]
pub struct PublicTx {
    pub txid: String,
    pub mined_height: Option<u64>,
    pub size_bytes: usize,
    pub version: String,
    pub expiry_height: u32,
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    /// Net value leaving each pool (positive = into fees / out of the pool), in zatoshis.
    pub orchard_value_balance: i64,
    pub ironwood_value_balance: i64,
    /// A few bytes of the first action's encrypted note, to show what's on chain.
    pub sample_ciphertext_hex: Option<String>,
    pub sample_nullifier_hex: Option<String>,
}

pub async fn public_view(
    client: &mut CompactTxStreamerClient<Channel>,
    txid_hex: &str,
) -> anyhow::Result<PublicTx> {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol::consensus::BranchId;

    let mut hash = hex::decode(txid_hex).context("txid must be hex")?;
    hash.reverse();
    let raw = client
        .get_transaction(service::TxFilter { hash, ..Default::default() })
        .await?
        .into_inner();
    let tip = client.get_latest_block(service::ChainSpec::default()).await?.into_inner().height;
    let height = if raw.height > 0 { raw.height } else { tip };
    let tx = Transaction::read(&raw.data[..], BranchId::for_height(&NETWORK, BlockHeight::from(height as u32)))?;

    let orchard = tx.orchard_bundle();
    let ironwood = tx.ironwood_bundle();
    let first = ironwood.or(orchard).map(|b| b.actions().first());
    Ok(PublicTx {
        txid: txid_hex.to_string(),
        mined_height: (raw.height > 0).then_some(raw.height),
        size_bytes: raw.data.len(),
        version: format!("{:?}", tx.version()),
        expiry_height: u32::from(tx.expiry_height()),
        transparent_inputs: tx.transparent_bundle().map_or(0, |b| b.vin.len()),
        transparent_outputs: tx.transparent_bundle().map_or(0, |b| b.vout.len()),
        sapling_spends: tx.sapling_bundle().map_or(0, |b| b.shielded_spends().len()),
        sapling_outputs: tx.sapling_bundle().map_or(0, |b| b.shielded_outputs().len()),
        orchard_actions: orchard.map_or(0, |b| b.actions().len()),
        ironwood_actions: ironwood.map_or(0, |b| b.actions().len()),
        orchard_value_balance: orchard.map_or(0, |b| i64::from(*b.value_balance())),
        ironwood_value_balance: ironwood.map_or(0, |b| i64::from(*b.value_balance())),
        sample_ciphertext_hex: first.map(|a| hex::encode(&a.encrypted_note().enc_ciphertext.as_ref()[..32])),
        sample_nullifier_hex: first.map(|a| hex::encode(a.nullifier().to_bytes())),
    })
}
