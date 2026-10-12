//! Browser bindings for `zebfin-signer`.
//!
//! The JS side holds the seed phrase only transiently: it unwraps it with a
//! passkey-derived key, calls `sign`, and drops it. Everything here is pure
//! computation; nothing touches the network or storage.

use wasm_bindgen::prelude::*;
use zebfin_signer::{DeviceSigner, SignerKeyFile, pczt::Pczt};

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn signer(mnemonic: &str, account_index: u32) -> Result<DeviceSigner, JsError> {
    DeviceSigner::from_key_file(&SignerKeyFile {
        network: "test".into(),
        mnemonic: mnemonic.into(),
        account_index,
    })
    .map_err(err)
}

/// Generates a new 24-word seed. Returns JSON `{ mnemonic, ufvk, seed_fingerprint, account_index }`.
#[wasm_bindgen(js_name = generateSeed)]
pub fn generate_seed(account_index: u32) -> Result<String, JsError> {
    let (s, file) = DeviceSigner::generate(account_index).map_err(err)?;
    let export = s.export_account().map_err(err)?;
    Ok(serde_json::json!({
        "mnemonic": file.mnemonic,
        "ufvk": export.ufvk,
        "seed_fingerprint": export.seed_fingerprint,
        "account_index": export.account_index,
    })
    .to_string())
}

/// The view-only export for an existing seed. JSON `{ ufvk, seed_fingerprint, account_index }`.
#[wasm_bindgen(js_name = exportAccount)]
pub fn export_account(mnemonic: &str, account_index: u32) -> Result<String, JsError> {
    let e = signer(mnemonic, account_index)?.export_account().map_err(err)?;
    serde_json::to_string(&e).map_err(err)
}

/// Decodes what a PCZT pays, computed locally from the PCZT bytes (never
/// trusting a server-provided summary). JSON `PcztSummary`.
#[wasm_bindgen]
pub fn summarize(pczt: &[u8]) -> Result<String, JsError> {
    let pczt = Pczt::parse(pczt).map_err(|e| err(format!("{e:?}")))?;
    let (summary, _) = zebfin_signer::summarize(pczt).map_err(err)?;
    serde_json::to_string(&summary).map_err(err)
}

/// Signs every Orchard/Ironwood spend in `pczt` that belongs to this seed.
#[wasm_bindgen]
pub fn sign(mnemonic: &str, account_index: u32, pczt: &[u8]) -> Result<Vec<u8>, JsError> {
    let pczt = Pczt::parse(pczt).map_err(|e| err(format!("{e:?}")))?;
    let signed = signer(mnemonic, account_index)?.sign(pczt).map_err(err)?;
    signed.serialize().map_err(|e| err(format!("{e:?}")))
}

/// Validates a payee address (Orchard receiver, testnet).
#[wasm_bindgen(js_name = validatePayee)]
pub fn validate_payee(address: &str) -> Result<(), JsError> {
    zebfin_signer::validate_payee(address).map(|_| ()).map_err(err)
}
