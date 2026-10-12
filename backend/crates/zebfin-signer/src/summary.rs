//! A human-readable view of what a PCZT will do, shown to an approver before signing.

use std::convert::Infallible;

use anyhow::anyhow;
use pczt::{Pczt, roles::verifier::Verifier};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PcztOutput {
    pub pool: &'static str,
    /// The payee address, if the creator recorded it. Change and padding
    /// outputs have no user address.
    pub address: Option<String>,
    pub value_zats: u64,
}

#[derive(Debug, Serialize)]
pub struct PcztSummary {
    pub orchard_actions: usize,
    pub ironwood_actions: usize,
    pub sapling_spends: usize,
    pub sapling_outputs: usize,
    pub transparent_inputs: usize,
    pub transparent_outputs: usize,
    pub spent_zats: u64,
    pub payments: Vec<PcztOutput>,
    pub change_zats: u64,
    pub fee_zats: u64,
    /// The transaction can't be mined after this height, so it must be signed
    /// and broadcast before then (about 40 blocks after creation).
    pub expiry_height: u32,
}

pub fn summarize(pczt: Pczt) -> anyhow::Result<(PcztSummary, Pczt)> {
    let mut summary = PcztSummary {
        orchard_actions: 0,
        ironwood_actions: 0,
        sapling_spends: pczt.sapling().spends().len(),
        sapling_outputs: pczt.sapling().outputs().len(),
        transparent_inputs: pczt.transparent().inputs().len(),
        transparent_outputs: pczt.transparent().outputs().len(),
        spent_zats: 0,
        payments: vec![],
        change_zats: 0,
        fee_zats: 0,
        expiry_height: *pczt.global().expiry_height(),
    };

    let visit = |pool: &'static str, bundle: &orchard::pczt::Bundle, s: &mut PcztSummary| {
        for action in bundle.actions() {
            if let Some(v) = action.spend().value() {
                s.spent_zats += v.inner();
            }
            let out = action.output();
            let value = out.value().map(|v| v.inner()).unwrap_or(0);
            match out.user_address() {
                Some(addr) => s.payments.push(PcztOutput {
                    pool,
                    address: Some(addr.clone()),
                    value_zats: value,
                }),
                None => s.change_zats += value,
            }
        }
        bundle.actions().len()
    };

    let mut orchard_actions = 0;
    let mut ironwood_actions = 0;
    let pczt = Verifier::new(pczt)
        .with_orchard::<Infallible, _>(|b| {
            orchard_actions = visit("orchard", b, &mut summary);
            Ok(())
        })
        .map_err(|e| anyhow!("Invalid Orchard bundle: {e:?}"))?
        .with_ironwood::<Infallible, _>(|b| {
            ironwood_actions = visit("ironwood", b, &mut summary);
            Ok(())
        })
        .map_err(|e| anyhow!("Invalid Ironwood bundle: {e:?}"))?
        .finish();
    summary.orchard_actions = orchard_actions;
    summary.ironwood_actions = ironwood_actions;

    let paid: u64 = summary.payments.iter().map(|p| p.value_zats).sum();
    summary.fee_zats = summary
        .spent_zats
        .saturating_sub(paid)
        .saturating_sub(summary.change_zats);
    Ok((summary, pczt))
}
