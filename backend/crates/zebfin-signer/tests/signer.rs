//! Offline tests for the approver-side signer: no network, no keys with funds.

use zcash_address::{ToAddress, ZcashAddress};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_protocol::consensus::{MainNetwork, NetworkType};
use zebfin_signer::{DeviceSigner, pczt::Pczt, summarize, validate_payee};

const FIXTURE: &[u8] = include_bytes!("fixtures/phase0-payment.created");

fn fresh_testnet_address() -> String {
    let (signer, _) = DeviceSigner::generate(0).unwrap();
    let export = signer.export_account().unwrap();
    let ufvk = zcash_keys::keys::UnifiedFullViewingKey::decode(&zebfin_signer::NETWORK, &export.ufvk).unwrap();
    let (ua, _) = ufvk.default_address(UnifiedAddressRequest::ORCHARD).unwrap();
    ua.encode(&zebfin_signer::NETWORK)
}

#[test]
fn accepts_testnet_orchard_unified_address() {
    assert!(validate_payee(&fresh_testnet_address()).is_ok());
}

#[test]
fn rejects_transparent_and_sapling_only_addresses() {
    let t = ZcashAddress::from_transparent_p2pkh(NetworkType::Test, [7u8; 20]).encode();
    let err = validate_payee(&t).unwrap_err().to_string();
    assert!(err.contains("Orchard receiver"), "{err}");

    let z = ZcashAddress::from_sapling(NetworkType::Test, [9u8; 43]).encode();
    assert!(validate_payee(&z).is_err());
}

#[test]
fn rejects_mainnet_addresses() {
    let seed = [1u8; 32];
    let usk = UnifiedSpendingKey::from_seed(&MainNetwork, &seed, zip32::AccountId::ZERO).unwrap();
    let (ua, _) = usk
        .to_unified_full_viewing_key()
        .default_address(UnifiedAddressRequest::ORCHARD)
        .unwrap();
    let err = validate_payee(&ua.encode(&MainNetwork)).unwrap_err().to_string();
    assert!(err.contains("not a testnet"), "{err}");
}

#[test]
fn rejects_garbage() {
    assert!(validate_payee("utest1notarealaddress").is_err());
    assert!(validate_payee("").is_err());
}

#[test]
fn export_is_orchard_only_view_key() {
    let (signer, file) = DeviceSigner::generate(0).unwrap();
    let export = signer.export_account().unwrap();
    assert!(export.ufvk.starts_with("uviewtest1"));
    let ufvk = zcash_keys::keys::UnifiedFullViewingKey::decode(&zebfin_signer::NETWORK, &export.ufvk).unwrap();
    assert!(ufvk.orchard().is_some());
    // The encoding itself holds exactly one item: no Sapling or transparent key.
    use zcash_address::unified::{Container, Encoding, Fvk, Ufvk};
    let (_, _, raw) = Ufvk::decode(&export.ufvk).unwrap();
    assert!(matches!(raw.items().as_slice(), [Fvk::Orchard(_)]));
    // Deterministic from the seed phrase.
    let again = DeviceSigner::from_key_file(&file).unwrap().export_account().unwrap();
    assert_eq!(again.ufvk, export.ufvk);
    assert_eq!(again.seed_fingerprint, export.seed_fingerprint);
}

#[test]
fn refuses_non_testnet_key_files() {
    let (_, mut file) = DeviceSigner::generate(0).unwrap();
    file.network = "main".into();
    assert!(DeviceSigner::from_key_file(&file).is_err());
}

#[test]
fn summarizes_a_real_testnet_pczt() {
    let pczt = Pczt::parse(FIXTURE).unwrap();
    let (s, _) = summarize(pczt).unwrap();
    assert_eq!(s.orchard_actions, 0);
    assert_eq!(s.ironwood_actions, 2);
    assert_eq!(s.sapling_spends + s.sapling_outputs + s.transparent_inputs + s.transparent_outputs, 0);
    assert_eq!(s.payments.len(), 1);
    assert_eq!(s.payments[0].value_zats, 100_000);
    assert_eq!(s.fee_zats, 10_000);
    assert_eq!(s.spent_zats, s.payments[0].value_zats + s.change_zats + s.fee_zats);
    assert!(s.expiry_height > 4_483_000);
}

#[test]
fn will_not_sign_for_a_seed_that_owns_no_spends() {
    let (stranger, _) = DeviceSigner::generate(0).unwrap();
    let err = stranger.sign(Pczt::parse(FIXTURE).unwrap()).unwrap_err().to_string();
    assert!(err.contains("No spends"), "{err}");
}
