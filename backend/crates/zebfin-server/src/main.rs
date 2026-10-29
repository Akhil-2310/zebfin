//! `zebfin-server`: the Zebfin API.
//!
//! Configuration (env):
//! - `DATABASE_URL`       Postgres URL for the ciphertext-only app database
//! - `ZEBFIN_DATA_DIR`    wallet-service storage (default `./data`)
//! - `ZEBFIN_LIGHTWALLETD` testnet light-client server (default testnet.zec.rocks)
//! - `ZEBFIN_BIND`        listen address (default `127.0.0.1:8080`)
//! - `ZEBFIN_CORS_ORIGIN` web app origin, also the passkey origin (default `http://localhost:3000`)
//! - `ZEBFIN_RP_ID`       passkey relying-party ID (default `localhost`)
//! - `ZEBFIN_SYNC_SECS`   background sync interval (default 30, 0 disables)

mod auth;
mod error;
mod routes;
mod wallets;

use std::{path::PathBuf, time::Duration};

use anyhow::Context;
use axum::{
    Json, Router,
    extract::DefaultBodyLimit,
    http::{HeaderValue, Method, header},
    routing::{get, post, put},
};
use serde_json::json;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use routes::{accounts, faucet, members, orgs, passkeys, payments, policy, portals, rates, records};
use wallets::WalletService;

#[derive(Clone)]
pub struct AppState {
    pub db: deadpool_postgres::Pool,
    pub wallets: WalletService,
    pub passkeys: passkeys::Passkeys,
    pub rates: rates::Rates,
    /// Testnet faucet, when configured (ZEBFIN_FAUCET_KEY + ZEBFIN_FAUCET_ACCOUNT).
    pub faucet: Option<std::sync::Arc<routes::faucet::Faucet>>,
    /// Wakes the broadcast loop when a payment is scheduled.
    pub scheduled: std::sync::Arc<tokio::sync::Notify>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn router(state: AppState, cors_origin: &str) -> anyhow::Result<Router> {
    let cors = CorsLayer::new()
        .allow_origin(cors_origin.parse::<HeaderValue>()?)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-portal-verifier"),
        ]);

    Ok(Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "network": "testnet" })) }))
        .route("/v1/orgs", post(orgs::create))
        .route("/v1/signup/start", post(passkeys::signup_start))
        .route("/v1/signup/finish", post(passkeys::signup_finish))
        .route("/v1/login/start", post(passkeys::login_start))
        .route("/v1/login/finish", post(passkeys::login_finish))
        .route("/v1/passkeys/start", post(passkeys::add_start))
        .route("/v1/passkeys/finish", post(passkeys::add_finish))
        .route("/v1/recovery", put(passkeys::recovery_set))
        .route("/v1/recovery/login", post(passkeys::recovery_login))
        .route("/v1/me", get(passkeys::me))
        .route("/v1/members", get(members::list))
        .route("/v1/policy", get(policy::get).put(policy::propose))
        .route("/v1/faucet", get(faucet::status).post(faucet::drip))
        .route("/v1/policy/confirm", post(policy::confirm))
        .route("/v1/payees", get(policy::list_payees).post(policy::add_payee).delete(policy::remove_payee))
        .route("/v1/invites", post(members::create_invite))
        .route("/v1/invites/{id}/start", post(members::join_start))
        .route("/v1/invites/{id}/finish", post(members::join_finish))
        .route("/v1/org", get(orgs::get).put(orgs::update))
        .route("/v1/keys", get(orgs::list_keys))
        .route("/v1/keys/{member_id}", axum::routing::delete(orgs::delete_member_keys))
        .route("/v1/keys/{member_id}/{key_version}", put(orgs::put_key))
        .route("/v1/records", get(records::list))
        .route(
            "/v1/records/{id}",
            get(records::get).put(records::put).delete(records::delete),
        )
        .route("/v1/accounts", get(accounts::list).post(accounts::import))
        .route("/v1/accounts/{id}/sync", post(accounts::sync))
        .route("/v1/accounts/{id}/balance", get(accounts::balance))
        .route("/v1/accounts/{id}/addresses", post(accounts::new_address))
        .route("/v1/accounts/{id}/history", get(accounts::history))
        .route("/v1/accounts/{id}/transactions", get(accounts::transactions))
        .route("/v1/accounts/{id}/viewing-key", get(accounts::viewing_key))
        .route(
            "/v1/accounts/{id}/payments",
            get(payments::list).post(payments::create),
        )
        .route("/v1/portals", post(portals::create))
        .route("/v1/portals/{id}", get(portals::org_get).delete(portals::org_delete))
        .route("/v1/portals/{id}/items/{item}", put(portals::org_put_item))
        .route("/v1/portal/{id}", get(portals::contributor_get))
        .route("/v1/portal/{id}/response", put(portals::contributor_respond))
        .route("/v1/public/tx/{txid}", get(accounts::public_tx))
        .route("/v1/rates/zec-usd", get(rates::zec_usd))
        .route("/v1/rates/zec-usd/daily", get(rates::zec_usd_daily))
        .route("/v1/payments/{id}", get(payments::get).delete(payments::cancel))
        .route("/v1/payments/{id}/build", post(payments::build))
        .route("/v1/payments/{id}/signature", post(payments::submit_signature))
        .route("/v1/payments/{id}/approve/start", post(payments::approve_start))
        .route("/v1/payments/{id}/approve/finish", post(payments::approve_finish))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}

/// Applies embedded SQL migrations in order, once each.
async fn migrate(db: &deadpool_postgres::Pool) -> anyhow::Result<()> {
    const MIGRATIONS: &[(&str, &str)] = &[
        ("0001_init", include_str!("../migrations/0001_init.sql")),
        ("0002_passkeys", include_str!("../migrations/0002_passkeys.sql")),
        ("0003_approvals", include_str!("../migrations/0003_approvals.sql")),
        ("0004_scheduled_broadcast", include_str!("../migrations/0004_scheduled_broadcast.sql")),
        ("0005_portals", include_str!("../migrations/0005_portals.sql")),
        ("0006_treasury", include_str!("../migrations/0006_treasury.sql")),
        ("0007_portal_expiry", include_str!("../migrations/0007_portal_expiry.sql")),
        ("0008_kudos", include_str!("../migrations/0008_kudos.sql")),
        ("0009_auctions", include_str!("../migrations/0009_auctions.sql")),
    ];
    let mut client = db.get().await?;
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        )
        .await?;
    for (name, sql) in MIGRATIONS {
        let tx = client.transaction().await?;
        let done = tx
            .query_opt("SELECT name FROM schema_migrations WHERE name = $1", &[name])
            .await?;
        if done.is_none() {
            tracing::info!("applying migration {name}");
            tx.batch_execute(sql).await?;
            tx.execute("INSERT INTO schema_migrations (name) VALUES ($1)", &[name])
                .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}

/// Keeps every account synced so incoming payments and confirmations show up
/// without a client asking.
/// Connects to the database over IPv4 when it has an IPv4 address. Some hosts
/// (Railway) have no outbound IPv6, and managed Postgres (Neon) publishes both.
/// The hostname stays set, so TLS still verifies it.
async fn prefer_ipv4(config: &mut tokio_postgres::Config) {
    use tokio_postgres::config::Host;
    if !config.get_hostaddrs().is_empty() {
        return;
    }
    let [Host::Tcp(host)] = config.get_hosts() else { return };
    let port = config.get_ports().first().copied().unwrap_or(5432);
    let host = host.clone();
    match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(addrs) => {
            if let Some(v4) = addrs.into_iter().find(|a| a.is_ipv4()) {
                config.hostaddr(v4.ip());
            }
        }
        Err(e) => tracing::warn!("couldn't resolve database host {host}: {e}"),
    }
}

async fn sync_loop(state: AppState, every: Duration) {
    let mut tick = tokio::time::interval(every);
    loop {
        tick.tick().await;
        // Close pooled connections idle for over a minute, so a serverless
        // Postgres (Neon) can scale to zero between requests.
        state.db.retain(|_, m| m.last_used() < Duration::from_secs(60));
        for id in state.wallets.account_ids().await {
            let r = state
                .wallets
                .with_wallet(id, |w, rt, client| rt.block_on(w.sync(client)))
                .await;
            if let Err(e) = r {
                tracing::warn!("sync of account {id} failed: {e:#}");
            }
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,schemerz=warn,sqlx=warn,zcash_client_backend::sync=warn".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let data_dir = PathBuf::from(env_or("ZEBFIN_DATA_DIR", "./data"));
    let lightwalletd = env_or("ZEBFIN_LIGHTWALLETD", zebfin_wallet::DEFAULT_SERVER);
    // Hosts like Railway assign a port through PORT; ZEBFIN_BIND overrides it.
    let bind = std::env::var("ZEBFIN_BIND").unwrap_or_else(|_| match std::env::var("PORT") {
        Ok(port) => format!("0.0.0.0:{port}"),
        Err(_) => "127.0.0.1:8080".into(),
    });
    let cors_origin = env_or("ZEBFIN_CORS_ORIGIN", "http://localhost:3000");
    let rp_id = env_or("ZEBFIN_RP_ID", "localhost");
    let sync_secs: u64 = env_or("ZEBFIN_SYNC_SECS", "30").parse()?;

    let mut pg_config: tokio_postgres::Config = database_url.parse().context("invalid DATABASE_URL")?;
    prefer_ipv4(&mut pg_config).await;
    // TLS when the server offers it (managed Postgres such as Neon requires
    // it); a local Postgres without TLS still works under sslmode=prefer.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let tls = tokio_postgres_rustls::MakeRustlsConnect::new(
        rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth(),
    );
    let manager = deadpool_postgres::Manager::new(pg_config, tls);
    let db = deadpool_postgres::Pool::builder(manager).max_size(10).build()?;
    migrate(&db).await?;

    let client = zebfin_wallet::connect(&lightwalletd).await?;
    let wallets = WalletService::new(data_dir, client);
    let faucet = routes::faucet::Faucet::from_env(&db, &wallets).await?;
    let state = AppState {
        db,
        wallets,
        passkeys: passkeys::Passkeys::new(&rp_id, &cors_origin)?,
        rates: rates::Rates::default(),
        faucet,
        scheduled: Default::default(),
    };
    tokio::spawn(rates::refresh_loop(state.rates.clone()));

    tokio::spawn(routes::payments::broadcast_loop(state.clone()));
    if sync_secs > 0 {
        tokio::spawn(sync_loop(state.clone(), Duration::from_secs(sync_secs)));
    }

    let app = router(state, &cors_origin)?;
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("zebfin-server listening on http://{bind} (testnet, lightwalletd {lightwalletd})");
    axum::serve(listener, app).await?;
    Ok(())
}
