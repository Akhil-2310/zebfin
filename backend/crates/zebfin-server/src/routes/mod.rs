pub mod accounts;
pub mod faucet;
pub mod members;
pub mod orgs;
pub mod passkeys;
pub mod payments;
pub mod policy;
pub mod portals;
pub mod rates;
pub mod records;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Binary data (ciphertext, PCZTs) carried as standard base64 in JSON.
#[derive(Debug, Clone)]
pub struct B64(pub Vec<u8>);

impl Serialize for B64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for B64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD
            .decode(s)
            .map(B64)
            .map_err(serde::de::Error::custom)
    }
}

/// Upper bound on a single encrypted blob. Clients pad records to fixed size
/// buckets well below this.
pub const MAX_CIPHERTEXT: usize = 256 * 1024;

pub fn check_ciphertext(b: &B64) -> Result<(), crate::error::ApiError> {
    if b.0.is_empty() || b.0.len() > MAX_CIPHERTEXT {
        return Err(crate::error::ApiError::BadRequest(format!(
            "ciphertext must be 1..={MAX_CIPHERTEXT} bytes"
        )));
    }
    Ok(())
}
