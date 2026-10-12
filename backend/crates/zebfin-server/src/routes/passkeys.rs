//! Passkey sign-up and login (WebAuthn, usernameless).
//!
//! The server only verifies passkey signatures. The PRF extension, which
//! derives the secret that unwraps the org key, is evaluated entirely in the
//! browser; its output never reaches us.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use webauthn_rs::prelude::*;

use super::{B64, check_ciphertext};
use crate::{
    AppState,
    auth::{MemberAuth, create_session},
    error::{ApiError, ApiResult},
};

const CHALLENGE_TTL: Duration = Duration::from_secs(300);

pub(crate) enum Pending {
    Signup {
        org: Uuid,
        member: Uuid,
        reg: PasskeyRegistration,
    },
    AddPasskey {
        org: Uuid,
        member: Uuid,
        reg: PasskeyRegistration,
    },
    Login(DiscoverableAuthentication),
    Join {
        org: Uuid,
        member: Uuid,
        invite: Uuid,
        role: String,
        reg: PasskeyRegistration,
    },
    Approve {
        payment: Uuid,
        member: Uuid,
        auth: PasskeyAuthentication,
    },
}

#[derive(Clone)]
pub struct Passkeys {
    pub(crate) webauthn: Arc<Webauthn>,
    pending: Arc<Mutex<HashMap<Uuid, (Instant, Pending)>>>,
}

impl Passkeys {
    pub fn new(rp_id: &str, origin: &str) -> anyhow::Result<Self> {
        let origin = Url::parse(origin)?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin)?.rp_name("Zebfin").build()?;
        Ok(Self {
            webauthn: Arc::new(webauthn),
            pending: Default::default(),
        })
    }

    pub(crate) fn stash(&self, p: Pending) -> Uuid {
        let id = Uuid::new_v4();
        let mut map = self.pending.lock().unwrap();
        map.retain(|_, (t, _)| t.elapsed() < CHALLENGE_TTL);
        map.insert(id, (Instant::now(), p));
        id
    }

    pub(crate) fn take(&self, id: Uuid) -> ApiResult<Pending> {
        let mut map = self.pending.lock().unwrap();
        match map.remove(&id) {
            Some((t, p)) if t.elapsed() < CHALLENGE_TTL => Ok(p),
            _ => Err(ApiError::BadRequest("challenge expired; start again".into())),
        }
    }

    /// Registration options. The user name is a placeholder: the browser
    /// replaces `user.name`/`user.displayName` before calling
    /// `navigator.credentials.create`, so real names never reach the server.
    pub(crate) fn registration(
        &self,
        member: Uuid,
        exclude: Option<Vec<CredentialID>>,
    ) -> ApiResult<(CreationChallengeResponse, PasskeyRegistration)> {
        self.webauthn
            .start_passkey_registration(member, "zebfin-member", "Zebfin member", exclude)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("webauthn: {e}")))
    }
}

#[derive(Serialize)]
pub struct StartResponse<T: Serialize> {
    pub challenge_id: Uuid,
    pub org_id: Option<Uuid>,
    pub member_id: Option<Uuid>,
    pub options: T,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub org_id: Uuid,
    pub member_id: Uuid,
    pub token: String,
}

/// Step 1 of sign-up: allocate org + member IDs and return passkey creation options.
pub async fn signup_start(State(state): State<AppState>) -> ApiResult<Json<StartResponse<CreationChallengeResponse>>> {
    let org = Uuid::new_v4();
    let member = Uuid::new_v4();
    let (options, reg) = state.passkeys.registration(member, None)?;
    let challenge_id = state.passkeys.stash(Pending::Signup { org, member, reg });
    Ok(Json(StartResponse {
        challenge_id,
        org_id: Some(org),
        member_id: Some(member),
        options,
    }))
}

#[derive(Deserialize)]
pub struct SignupFinish {
    pub challenge_id: Uuid,
    pub credential: RegisterPublicKeyCredential,
    /// Org name and settings, encrypted under the new org key.
    pub meta_ciphertext: B64,
}

/// Step 2 of sign-up: verify the passkey and create org, member and session.
pub async fn signup_finish(
    State(state): State<AppState>,
    Json(body): Json<SignupFinish>,
) -> ApiResult<(StatusCode, Json<SessionResponse>)> {
    check_ciphertext(&body.meta_ciphertext)?;
    let Pending::Signup { org, member, reg } = state.passkeys.take(body.challenge_id)? else {
        return Err(ApiError::BadRequest("wrong challenge type".into()));
    };
    let passkey = state
        .passkeys
        .webauthn
        .finish_passkey_registration(&body.credential, &reg)
        .map_err(|e| ApiError::BadRequest(format!("passkey registration failed: {e}")))?;

    let mut db = state.db.get().await?;
    let tx = db.transaction().await?;
    tx.execute(
        "INSERT INTO orgs (id, meta_ciphertext) VALUES ($1, $2)",
        &[&org, &body.meta_ciphertext.0],
    )
    .await?;
    tx.execute("INSERT INTO members (id, org_id) VALUES ($1, $2)", &[&member, &org])
        .await?;
    store_passkey(&tx, member, &passkey).await?;
    tx.commit().await?;

    let token = create_session(&db, org, member).await?;
    Ok((
        StatusCode::CREATED,
        Json(SessionResponse {
            org_id: org,
            member_id: member,
            token,
        }),
    ))
}

pub(crate) async fn store_passkey(
    db: &impl deadpool_postgres::GenericClient,
    member: Uuid,
    passkey: &Passkey,
) -> ApiResult<()> {
    let json = serde_json::to_string(passkey).map_err(anyhow::Error::from)?;
    db.execute(
        "INSERT INTO passkeys (cred_id, member_id, passkey) VALUES ($1, $2, $3)",
        &[&passkey.cred_id().as_ref(), &member, &json],
    )
    .await?;
    Ok(())
}

/// Adds another passkey (e.g. a second device) for the signed-in member.
pub async fn add_start(
    State(state): State<AppState>,
    auth: MemberAuth,
) -> ApiResult<Json<StartResponse<CreationChallengeResponse>>> {
    let db = state.db.get().await?;
    let existing: Vec<CredentialID> = db
        .query("SELECT cred_id FROM passkeys WHERE member_id = $1", &[&auth.member])
        .await?
        .iter()
        .map(|r| CredentialID::from(r.get::<_, Vec<u8>>(0)))
        .collect();
    let (options, reg) = state.passkeys.registration(auth.member, Some(existing))?;
    let challenge_id = state.passkeys.stash(Pending::AddPasskey {
        org: auth.org,
        member: auth.member,
        reg,
    });
    Ok(Json(StartResponse {
        challenge_id,
        org_id: Some(auth.org),
        member_id: Some(auth.member),
        options,
    }))
}

#[derive(Deserialize)]
pub struct AddFinish {
    pub challenge_id: Uuid,
    pub credential: RegisterPublicKeyCredential,
}

pub async fn add_finish(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(body): Json<AddFinish>,
) -> ApiResult<StatusCode> {
    let Pending::AddPasskey { org, member, reg } = state.passkeys.take(body.challenge_id)? else {
        return Err(ApiError::BadRequest("wrong challenge type".into()));
    };
    if org != auth.org || member != auth.member {
        return Err(ApiError::Unauthorized);
    }
    let passkey = state
        .passkeys
        .webauthn
        .finish_passkey_registration(&body.credential, &reg)
        .map_err(|e| ApiError::BadRequest(format!("passkey registration failed: {e}")))?;
    store_passkey(&state.db.get().await?, member, &passkey).await?;
    Ok(StatusCode::CREATED)
}

/// Step 1 of login: a usernameless challenge any of the user's passkeys can answer.
pub async fn login_start(
    State(state): State<AppState>,
) -> ApiResult<Json<StartResponse<RequestChallengeResponse>>> {
    let (options, auth) = state
        .passkeys
        .webauthn
        .start_discoverable_authentication()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("webauthn: {e}")))?;
    let challenge_id = state.passkeys.stash(Pending::Login(auth));
    Ok(Json(StartResponse {
        challenge_id,
        org_id: None,
        member_id: None,
        options,
    }))
}

#[derive(Deserialize)]
pub struct LoginFinish {
    pub challenge_id: Uuid,
    pub credential: PublicKeyCredential,
}

pub async fn login_finish(
    State(state): State<AppState>,
    Json(body): Json<LoginFinish>,
) -> ApiResult<Json<SessionResponse>> {
    let Pending::Login(auth) = state.passkeys.take(body.challenge_id)? else {
        return Err(ApiError::BadRequest("wrong challenge type".into()));
    };
    let (member, cred_id) = state
        .passkeys
        .webauthn
        .identify_discoverable_authentication(&body.credential)
        .map_err(|e| ApiError::BadRequest(format!("unrecognized passkey: {e}")))?;

    let db = state.db.get().await?;
    let row = db
        .query_opt(
            "SELECT p.passkey, m.org_id FROM passkeys p JOIN members m ON m.id = p.member_id
             WHERE p.cred_id = $1 AND p.member_id = $2",
            &[&cred_id, &member],
        )
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let mut passkey: Passkey =
        serde_json::from_str(row.get::<_, &str>(0)).map_err(anyhow::Error::from)?;
    let org: Uuid = row.get(1);

    let result = state
        .passkeys
        .webauthn
        .finish_discoverable_authentication(&body.credential, auth, &[DiscoverableKey::from(&passkey)])
        .map_err(|_| ApiError::Unauthorized)?;

    // Persist the updated signature counter (clone detection).
    if passkey.update_credential(&result) == Some(true) {
        let json = serde_json::to_string(&passkey).map_err(anyhow::Error::from)?;
        db.execute(
            "UPDATE passkeys SET passkey = $2, last_used_at = now() WHERE cred_id = $1",
            &[&passkey.cred_id().as_ref(), &json],
        )
        .await?;
    } else {
        db.execute(
            "UPDATE passkeys SET last_used_at = now() WHERE cred_id = $1",
            &[&passkey.cred_id().as_ref()],
        )
        .await?;
    }

    let token = create_session(&db, org, member).await?;
    Ok(Json(SessionResponse {
        org_id: org,
        member_id: member,
        token,
    }))
}

#[derive(Serialize)]
pub struct Me {
    pub org_id: Uuid,
    pub member_id: Uuid,
}

pub async fn me(auth: MemberAuth) -> Json<Me> {
    Json(Me {
        org_id: auth.org,
        member_id: auth.member,
    })
}

#[derive(Deserialize)]
pub struct RecoveryKit {
    pub lookup_id: B64,
    pub verifier: B64,
}

fn check_kit(kit: &RecoveryKit) -> ApiResult<()> {
    if kit.lookup_id.0.len() != 32 || kit.verifier.0.len() != 32 {
        return Err(ApiError::BadRequest("lookup_id and verifier must be 32 bytes".into()));
    }
    Ok(())
}

/// Registers (or replaces) the signed-in member's recovery kit.
pub async fn recovery_set(
    State(state): State<AppState>,
    auth: MemberAuth,
    Json(kit): Json<RecoveryKit>,
) -> ApiResult<StatusCode> {
    use sha2::{Digest, Sha256};
    check_kit(&kit)?;
    let mut db = state.db.get().await?;
    let tx = db.transaction().await?;
    tx.execute("DELETE FROM recovery_kits WHERE member_id = $1", &[&auth.member])
        .await?;
    tx.execute(
        "INSERT INTO recovery_kits (lookup_id, verifier_hash, org_id, member_id) VALUES ($1, $2, $3, $4)",
        &[&kit.lookup_id.0, &Sha256::digest(&kit.verifier.0).to_vec(), &auth.org, &auth.member],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Logs in with a recovery kit, after which the browser registers a new passkey.
pub async fn recovery_login(
    State(state): State<AppState>,
    Json(kit): Json<RecoveryKit>,
) -> ApiResult<Json<SessionResponse>> {
    use sha2::{Digest, Sha256};
    check_kit(&kit)?;
    let db = state.db.get().await?;
    let row = db
        .query_opt(
            "SELECT verifier_hash, org_id, member_id FROM recovery_kits WHERE lookup_id = $1",
            &[&kit.lookup_id.0],
        )
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let stored: Vec<u8> = row.get(0);
    let given = Sha256::digest(&kit.verifier.0);
    // Constant-time comparison.
    if stored.len() != given.len() || stored.iter().zip(given.iter()).fold(0u8, |a, (x, y)| a | (x ^ y)) != 0 {
        return Err(ApiError::Unauthorized);
    }
    let (org, member): (Uuid, Uuid) = (row.get(1), row.get(2));
    let token = create_session(&db, org, member).await?;
    Ok(Json(SessionResponse {
        org_id: org,
        member_id: member,
        token,
    }))
}

/// A member's registered passkeys, for a non-discoverable (allow-list) ceremony.
pub(crate) async fn member_passkeys(state: &AppState, member: Uuid) -> ApiResult<Vec<Passkey>> {
    let rows = state
        .db
        .get()
        .await?
        .query("SELECT passkey FROM passkeys WHERE member_id = $1", &[&member])
        .await?;
    rows.iter()
        .map(|r| serde_json::from_str(r.get::<_, &str>(0)).map_err(|e| ApiError::Internal(e.into())))
        .collect()
}

/// Persists a passkey's updated signature counter after a successful assertion.
pub(crate) async fn record_use(state: &AppState, mut passkeys: Vec<Passkey>, result: &AuthenticationResult) -> ApiResult<()> {
    let db = state.db.get().await?;
    for pk in passkeys.iter_mut() {
        if pk.update_credential(result).is_some() {
            let json = serde_json::to_string(pk).map_err(anyhow::Error::from)?;
            db.execute(
                "UPDATE passkeys SET passkey = $2, last_used_at = now() WHERE cred_id = $1",
                &[&pk.cred_id().as_ref(), &json],
            )
            .await?;
        }
    }
    Ok(())
}
