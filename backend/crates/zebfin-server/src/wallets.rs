//! The view-only wallet service.
//!
//! This side sees payees and amounts (it has to, to build transactions), so it
//! is kept apart from the ciphertext-only app database: one SQLite wallet and
//! one PCZT directory per account under `data_dir`. The plan moves this
//! service into a hardware enclave; nothing here holds a spending key.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use tokio::sync::Mutex;
use tonic::transport::Channel;
use uuid::Uuid;
use zebfin_wallet::{
    Wallet,
    zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient,
};

pub type Client = CompactTxStreamerClient<Channel>;

#[derive(Clone)]
pub struct WalletService {
    data_dir: PathBuf,
    client: Client,
    open: Arc<Mutex<HashMap<Uuid, Arc<Mutex<Wallet>>>>>,
}

/// Which stage of a payment's PCZT a file holds.
#[derive(Clone, Copy)]
pub enum PcztStage {
    Created,
    Proven,
    Signed,
}

impl WalletService {
    pub fn new(data_dir: PathBuf, client: Client) -> Self {
        Self {
            data_dir,
            client,
            open: Default::default(),
        }
    }

    pub fn client(&self) -> Client {
        self.client.clone()
    }

    /// Accounts with a wallet on disk. Read from the data directory, not the
    /// app database, so background syncing never wakes the database.
    pub async fn account_ids(&self) -> Vec<Uuid> {
        let mut ids = vec![];
        if let Ok(mut dir) = tokio::fs::read_dir(self.data_dir.join("wallets")).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                if let Some(id) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
                    ids.push(id);
                }
            }
        }
        ids
    }

    fn account_dir(&self, account_id: Uuid) -> PathBuf {
        self.data_dir.join("wallets").join(account_id.to_string())
    }

    pub fn pczt_path(&self, account_id: Uuid, payment_id: Uuid, stage: PcztStage) -> PathBuf {
        let ext = match stage {
            PcztStage::Created => "created",
            PcztStage::Proven => "proven",
            PcztStage::Signed => "signed",
        };
        self.account_dir(account_id)
            .join("payments")
            .join(format!("{payment_id}.{ext}"))
    }

    /// The approved request contents (recipients, amounts, memos) of a payment.
    pub fn request_path(&self, account_id: Uuid, payment_id: Uuid) -> PathBuf {
        self.account_dir(account_id).join("payments").join(format!("{payment_id}.request.json"))
    }

    async fn wallet(&self, account_id: Uuid) -> anyhow::Result<Arc<Mutex<Wallet>>> {
        let mut open = self.open.lock().await;
        if let Some(w) = open.get(&account_id) {
            return Ok(w.clone());
        }
        let dir = self.account_dir(account_id);
        let wallet = tokio::task::spawn_blocking(move || Wallet::open(&dir)).await??;
        let wallet = Arc::new(Mutex::new(wallet));
        open.insert(account_id, wallet.clone());
        Ok(wallet)
    }

    /// Runs `f` with exclusive access to an account's wallet on a blocking
    /// thread. `f` may drive async wallet calls via the given runtime handle.
    /// (The SQLite connection is not `Sync`, so it can't be held across
    /// `.await` points in an ordinary async task.)
    pub async fn with_wallet<T, F>(&self, account_id: Uuid, f: F) -> anyhow::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Wallet, &tokio::runtime::Handle, &mut Client) -> anyhow::Result<T>
            + Send
            + 'static,
    {
        let wallet = self.wallet(account_id).await?;
        let mut client = self.client.clone();
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let mut guard = wallet.blocking_lock();
            f(&mut guard, &handle, &mut client)
        })
        .await
        .context("wallet task panicked")?
    }

    pub async fn write_pczt(&self, path: &Path, bytes: Vec<u8>) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, bytes).await?;
        Ok(())
    }
}
