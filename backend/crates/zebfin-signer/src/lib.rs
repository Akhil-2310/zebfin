//! Approver-side signing for Zebfin.
//!
//! The spending key only ever lives here, on the approver's device. The backend
//! creates and proves a PCZT with a view-only wallet; this crate shows what the
//! PCZT pays and adds spend authorization signatures.
//!
//! Only Orchard-protocol spends (the Orchard pool and, after NU6.3, the Ironwood
//! pool) are signed. A PCZT that spends Sapling or transparent funds is rejected.

pub mod summary;

use std::convert::Infallible;

use anyhow::{Context, anyhow, bail};
use bip0039::{Count, English, Mnemonic};
use pczt::{
    Pczt,
    roles::{signer::Signer, verifier::Verifier},
};
use secrecy::{ExposeSecret, SecretVec};
use serde::{Deserialize, Serialize};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_protocol::consensus::{NetworkConstants, NetworkType, Parameters};
use zip32::{AccountId, fingerprint::SeedFingerprint};

pub use pczt;
pub use summary::{PcztSummary, summarize};

/// The only network Zebfin runs on.
pub const NETWORK: zcash_protocol::consensus::Network =
    zcash_protocol::consensus::Network::TestNetwork;

/// What an approver's device stores. On the CLI this is a JSON file; in the
/// browser it will be encrypted under a key derived from the approver's passkey.
#[derive(Serialize, Deserialize)]
pub struct SignerKeyFile {
    pub network: String,
    pub mnemonic: String,
    pub account_index: u32,
}

/// The public half of an account, which the backend's view-only wallet imports.
#[derive(Debug, Serialize, Deserialize)]
pub struct AccountExport {
    /// Orchard-only Unified Full Viewing Key.
    pub ufvk: String,
    /// Hex ZIP 32 seed fingerprint, so the PCZT carries derivation info for signing.
    pub seed_fingerprint: String,
    pub account_index: u32,
}

pub struct DeviceSigner {
    seed: SecretVec<u8>,
    account_index: AccountId,
}

impl DeviceSigner {
    /// Generates a fresh 24-word seed.
    pub fn generate(account_index: u32) -> anyhow::Result<(Self, SignerKeyFile)> {
        let mnemonic = Mnemonic::<English>::generate(Count::Words24);
        let file = SignerKeyFile {
            network: "test".into(),
            mnemonic: mnemonic.phrase().to_string(),
            account_index,
        };
        Ok((Self::from_key_file(&file)?, file))
    }

    pub fn from_key_file(file: &SignerKeyFile) -> anyhow::Result<Self> {
        if file.network != "test" {
            bail!("Zebfin only runs on testnet; key file is for {:?}", file.network);
        }
        let mnemonic = Mnemonic::<English>::from_phrase(file.mnemonic.trim())
            .map_err(|e| anyhow!("Invalid mnemonic: {e}"))?;
        Ok(Self {
            seed: SecretVec::new(mnemonic.to_seed("").to_vec()),
            account_index: AccountId::try_from(file.account_index)
                .map_err(|_| anyhow!("Invalid account index"))?,
        })
    }

    fn seed_fingerprint(&self) -> anyhow::Result<SeedFingerprint> {
        SeedFingerprint::from_seed(self.seed.expose_secret())
            .ok_or_else(|| anyhow!("Invalid seed length"))
    }

    fn usk(&self, account_index: AccountId) -> anyhow::Result<UnifiedSpendingKey> {
        UnifiedSpendingKey::from_seed(&NETWORK, self.seed.expose_secret(), account_index)
            .context("Failed to derive spending key")
    }

    /// Exports an Orchard-only UFVK. Leaving out the Sapling and transparent
    /// components means the backend wallet can never derive or watch a
    /// transparent or Sapling receiver for this account.
    pub fn export_account(&self) -> anyhow::Result<AccountExport> {
        let usk = self.usk(self.account_index)?;
        let orchard_fvk = orchard::keys::FullViewingKey::from(usk.orchard());
        let ufvk = UnifiedFullViewingKey::from_orchard_fvk(orchard_fvk)
            .context("Failed to build Orchard-only UFVK")?;
        Ok(AccountExport {
            ufvk: ufvk
                .encode(&NETWORK)
                .map_err(|e| anyhow!("Failed to encode UFVK: {e:?}"))?,
            seed_fingerprint: hex::encode(self.seed_fingerprint()?.to_bytes()),
            account_index: self.account_index.into(),
        })
    }

    /// Signs every Orchard and Ironwood spend in `pczt` that belongs to this seed.
    ///
    /// The caller must show the approver [`summarize`] output and get explicit
    /// confirmation before calling this.
    pub fn sign(&self, pczt: Pczt) -> anyhow::Result<Pczt> {
        if !pczt.sapling().spends().is_empty() {
            bail!("Refusing to sign: PCZT spends Sapling funds (Zebfin is Orchard-protocol only)");
        }
        if !pczt.transparent().inputs().is_empty() {
            bail!("Refusing to sign: PCZT spends transparent funds");
        }

        let seed_fp = self.seed_fingerprint()?;
        let coin_type = zip32::ChildIndex::hardened(NETWORK.network_type().coin_type());
        let ours = |bundle: &orchard::pczt::Bundle| -> Vec<(usize, AccountId)> {
            bundle
                .actions()
                .iter()
                .enumerate()
                .filter_map(|(index, action)| {
                    action
                        .spend()
                        .zip32_derivation()
                        .as_ref()
                        .and_then(|d| d.extract_account_index(&seed_fp, coin_type))
                        .map(|account| (index, account))
                })
                .collect()
        };

        let mut orchard_spends = vec![];
        let mut ironwood_spends = vec![];
        let pczt = Verifier::new(pczt)
            .with_orchard::<Infallible, _>(|bundle| {
                orchard_spends = ours(bundle);
                Ok(())
            })
            .map_err(|e| anyhow!("Invalid Orchard bundle: {e:?}"))?
            .with_ironwood::<Infallible, _>(|bundle| {
                ironwood_spends = ours(bundle);
                Ok(())
            })
            .map_err(|e| anyhow!("Invalid Ironwood bundle: {e:?}"))?
            .finish();

        if orchard_spends.is_empty() && ironwood_spends.is_empty() {
            bail!("No spends in this PCZT belong to this signer's seed");
        }

        let mut signer = Signer::new(pczt).map_err(|e| anyhow!("Signer init failed: {e:?}"))?;
        for (index, account) in orchard_spends {
            let ask = orchard::keys::SpendAuthorizingKey::from(self.usk(account)?.orchard());
            signer
                .sign_orchard(rand::rng(), index, &ask)
                .map_err(|e| anyhow!("Failed to sign Orchard spend {index}: {e:?}"))?;
        }
        for (index, account) in ironwood_spends {
            let ask = orchard::keys::SpendAuthorizingKey::from(self.usk(account)?.orchard());
            signer
                .sign_ironwood(rand::rng(), index, &ask)
                .map_err(|e| anyhow!("Failed to sign Ironwood spend {index}: {e:?}"))?;
        }
        Ok(signer.finish())
    }
}

/// Checks that a payee address can receive Orchard-protocol funds on testnet.
/// Transparent-only and Sapling-only addresses are rejected.
pub fn validate_payee(address: &str) -> anyhow::Result<zcash_address::ZcashAddress> {
    use zcash_protocol::PoolType;
    let addr: zcash_address::ZcashAddress =
        address.parse().map_err(|e| anyhow!("Invalid address: {e}"))?;
    if !addr.can_receive_as(PoolType::ORCHARD) {
        bail!("Address has no Orchard receiver; Zebfin only pays shielded Unified Addresses");
    }
    let is_testnet = addr
        .clone()
        .convert_if_network::<zcash_keys::address::Address>(NetworkType::Test)
        .is_ok();
    if !is_testnet {
        bail!("Address is not a testnet address");
    }
    Ok(addr)
}
