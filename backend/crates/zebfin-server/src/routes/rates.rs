//! ZEC/USD reference rate for USD-denominated payroll.
//!
//! Privacy: prices are fetched on a fixed timer, independent of any org's
//! activity, so price providers learn nothing about when anyone pays. At least
//! two independent sources must agree within `MAX_SPREAD` or no rate is quoted.
//! Testnet TAZ has no market price; the mainnet ZEC price is the reference.

use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use axum::{Json, extract::State};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::{
    AppState,
    auth::OrgAuth,
    error::{ApiError, ApiResult},
};

const MAX_SPREAD: f64 = 0.02;
const REFRESH: Duration = Duration::from_secs(300);
const STALE_AFTER_SECS: i64 = 1800;

#[derive(Clone, Serialize)]
pub struct Source {
    pub name: &'static str,
    pub usd_per_zec: f64,
}

#[derive(Clone, Serialize)]
pub struct Quote {
    /// Median of the agreeing sources.
    pub usd_per_zec: f64,
    pub sources: Vec<Source>,
    pub fetched_at: DateTime<Utc>,
    pub note: &'static str,
}

#[derive(Clone, Default)]
pub struct Rates(Arc<RwLock<Option<Quote>>>, Arc<RwLock<Option<DailyTable>>>);

impl Rates {
    /// The current two-source rate, if fresh.
    pub fn current_usd_per_zec(&self) -> Option<f64> {
        self.0
            .read()
            .unwrap()
            .as_ref()
            .filter(|q| (Utc::now() - q.fetched_at).num_seconds() < STALE_AFTER_SECS)
            .map(|q| q.usd_per_zec)
    }
}

/// Daily closing ZEC/USD prices, fetched in bulk (hundreds of days per
/// request) so lookups never reveal which days an org transacted.
#[derive(Clone, Serialize)]
pub struct DailyTable {
    pub fetched_at: DateTime<Utc>,
    pub days: Vec<DailyPrice>,
    pub note: &'static str,
}

#[derive(Clone, Serialize)]
pub struct DailyPrice {
    /// UTC date, YYYY-MM-DD.
    pub date: String,
    pub usd_per_zec: f64,
    pub sources: Vec<&'static str>,
    /// Both sources present but more than MAX_DAILY_SPREAD apart.
    pub disputed: bool,
}

const MAX_DAILY_SPREAD: f64 = 0.05;

async fn kraken_daily(c: &reqwest::Client) -> anyhow::Result<Vec<(i64, f64)>> {
    let v: serde_json::Value = c
        .get("https://api.kraken.com/0/public/OHLC?pair=ZECUSD&interval=1440")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(v["result"]["XZECZUSD"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("bad kraken response"))?
        .iter()
        .filter_map(|r| Some((r[0].as_i64()?, r[4].as_str()?.parse().ok()?)))
        .collect())
}

async fn coinbase_daily(c: &reqwest::Client) -> anyhow::Result<Vec<(i64, f64)>> {
    let v: serde_json::Value = c
        .get("https://api.exchange.coinbase.com/products/ZEC-USD/candles?granularity=86400")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(v.as_array()
        .ok_or_else(|| anyhow::anyhow!("bad coinbase response"))?
        .iter()
        .filter_map(|r| Some((r[0].as_i64()?, r[4].as_f64()?)))
        .collect())
}

async fn fetch_daily(c: &reqwest::Client) -> anyhow::Result<DailyTable> {
    use std::collections::BTreeMap;
    let (k, cb) = tokio::join!(kraken_daily(c), coinbase_daily(c));
    let mut by_day: BTreeMap<i64, Vec<(&'static str, f64)>> = BTreeMap::new();
    for (name, series) in [("Kraken", k), ("Coinbase", cb)] {
        match series {
            Ok(rows) => rows.into_iter().for_each(|(t, p)| by_day.entry(t).or_default().push((name, p))),
            Err(e) => tracing::warn!("{name} daily prices failed: {e:#}"),
        }
    }
    if by_day.is_empty() {
        anyhow::bail!("no daily prices available");
    }
    let days = by_day
        .into_iter()
        .map(|(t, ps)| {
            let prices: Vec<f64> = ps.iter().map(|(_, p)| *p).collect();
            let (lo, hi) = prices.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(*p), b.max(*p)));
            DailyPrice {
                date: DateTime::from_timestamp(t, 0).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default(),
                usd_per_zec: prices.iter().sum::<f64>() / prices.len() as f64,
                sources: ps.iter().map(|(n, _)| *n).collect(),
                disputed: prices.len() > 1 && (hi - lo) / lo > MAX_DAILY_SPREAD,
            }
        })
        .collect();
    Ok(DailyTable {
        fetched_at: Utc::now(),
        days,
        note: "Daily closes; mainnet ZEC/USD used as the reference for testnet TAZ",
    })
}

async fn coinbase(c: &reqwest::Client) -> anyhow::Result<f64> {
    let v: serde_json::Value = c
        .get("https://api.coinbase.com/v2/prices/ZEC-USD/spot")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(v["data"]["amount"].as_str().unwrap_or_default().parse()?)
}

async fn kraken(c: &reqwest::Client) -> anyhow::Result<f64> {
    let v: serde_json::Value = c
        .get("https://api.kraken.com/0/public/Ticker?pair=ZECUSD")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // Last trade price.
    Ok(v["result"]["XZECZUSD"]["c"][0].as_str().unwrap_or_default().parse()?)
}

async fn coingecko(c: &reqwest::Client) -> anyhow::Result<f64> {
    let v: serde_json::Value = c
        .get("https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    v["zcash"]["usd"].as_f64().ok_or_else(|| anyhow::anyhow!("no price"))
}

/// Fetches all sources and returns a quote if at least two agree.
async fn fetch(c: &reqwest::Client) -> anyhow::Result<Quote> {
    let (a, b, g) = tokio::join!(coinbase(c), kraken(c), coingecko(c));
    let mut sources: Vec<Source> = [("Coinbase", a), ("Kraken", b), ("CoinGecko", g)]
        .into_iter()
        .filter_map(|(name, r)| match r {
            Ok(p) if p > 0.0 => Some(Source { name, usd_per_zec: p }),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("{name} price fetch failed: {e:#}");
                None
            }
        })
        .collect();
    // Prefer the two exchanges; fall back to the aggregator only if needed.
    if sources.iter().filter(|s| s.name != "CoinGecko").count() >= 2 {
        sources.retain(|s| s.name != "CoinGecko");
    }
    if sources.len() < 2 {
        anyhow::bail!("fewer than two price sources available");
    }
    let mut prices: Vec<f64> = sources.iter().map(|s| s.usd_per_zec).collect();
    prices.sort_by(f64::total_cmp);
    let (lo, hi) = (prices[0], prices[prices.len() - 1]);
    if (hi - lo) / lo > MAX_SPREAD {
        anyhow::bail!("price sources disagree by more than {}%: {lo} vs {hi}", MAX_SPREAD * 100.0);
    }
    let mid = prices.len() / 2;
    let median = if prices.len() % 2 == 0 { (prices[mid - 1] + prices[mid]) / 2.0 } else { prices[mid] };
    Ok(Quote {
        usd_per_zec: median,
        sources,
        fetched_at: Utc::now(),
        note: "Mainnet ZEC/USD used as the reference for testnet TAZ",
    })
}

/// Refreshes the cached quote on a fixed timer.
pub async fn refresh_loop(rates: Rates) {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).user_agent("zebfin/0.1").build() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("price client: {e}");
            return;
        }
    };
    let mut tick = tokio::time::interval(REFRESH);
    let mut last_daily: Option<std::time::Instant> = None;
    loop {
        tick.tick().await;
        match fetch(&client).await {
            Ok(q) => *rates.0.write().unwrap() = Some(q),
            Err(e) => tracing::warn!("rate refresh: {e:#}"),
        }
        // Daily table: refresh every 6 hours.
        if last_daily.is_none_or(|t| t.elapsed() > Duration::from_secs(6 * 3600)) {
            match fetch_daily(&client).await {
                Ok(t) => {
                    *rates.1.write().unwrap() = Some(t);
                    last_daily = Some(std::time::Instant::now());
                }
                Err(e) => tracing::warn!("daily rate refresh: {e:#}"),
            }
        }
    }
}

pub async fn zec_usd(State(state): State<AppState>, OrgAuth(_): OrgAuth) -> ApiResult<Json<Quote>> {
    let q = state.rates.0.read().unwrap().clone();
    match q {
        Some(q) if (Utc::now() - q.fetched_at).num_seconds() < STALE_AFTER_SECS => Ok(Json(q)),
        _ => Err(ApiError::Conflict("no fresh ZEC/USD rate available; try again shortly".into())),
    }
}

pub async fn zec_usd_daily(State(state): State<AppState>, OrgAuth(_): OrgAuth) -> ApiResult<Json<DailyTable>> {
    state
        .rates
        .1
        .read()
        .unwrap()
        .clone()
        .map(Json)
        .ok_or_else(|| ApiError::Conflict("daily prices not loaded yet; try again shortly".into()))
}
