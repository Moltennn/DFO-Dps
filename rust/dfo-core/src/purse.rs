//! Deterministic encounter wrapper (`src/purse.js`).
use crate::{
    allowance::{claim_streams, run_allowance, ClaimInput, Proc},
    encounters::encounter_by_id,
    fight::obj,
    round::js_max,
    value::Value::{self, Bool, Null, Num, Str, Undefined},
};

#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn simulate_purse(base: &Value, id: &Value, opts: &Value) -> Result<Value, String> {
    let encounter =
        encounter_by_id(id).ok_or_else(|| format!("unknown encounter: {}", id.to_js_string()))?;
    let default = |key, d| match opts.get(key) {
        Undefined => d,
        v => v.to_number(),
    };
    let level = default("level", 45.0);
    let players = js_max(
        1.0,
        base.get("target")
            .get("allowance")
            .get("players")
            .num_or_default(1.0)
            .floor(),
    );
    let read = |key| base.get(key).num_or_default(0.0);
    let health = read("health") / players;
    let cap = read("cap");
    if !(health > 0.0) || !(cap > 0.0) {
        return Ok(Null);
    }
    let procs = base
        .get("enchantProcs")
        .items()
        .iter()
        .map(|p| Proc {
            name: p.get("name").as_str().map(str::to_owned),
            damage: p.get("damage").to_number(),
            dot_tick: p.get("dotTick").to_number(),
        })
        .collect::<Vec<_>>();
    let streams = claim_streams(&ClaimInput {
        capped_per_swing: read("cappedPerSwing"),
        hit: base.get("hit").get("hit").to_number(),
        aps: base.get("cadence").get("aps").to_number(),
        procs: &procs,
        cap,
        with_procs: true,
    });
    if streams.is_empty() {
        return Ok(Null);
    }
    // mutation: equivalent - run_allowance reads phases/opening/immunity from Spec, not players; share was computed above.
    let spec = encounter.spec(level, 1.0);
    let Some(report) = run_allowance(
        level,
        health + read("ward") / players,
        Some(&spec),
        &streams,
        true,
        default("splitPenaltyS", 0.0),
    ) else {
        return Ok(Null);
    };
    let r = report.run;
    Ok(obj([
        ("encounter", Str(encounter.id.into())),
        ("calibrated", Bool(encounter.calibrated)),
        ("ttk", r.ttk.map_or(Null, Num)),
        ("burst5", Num(r.burst5)),
        ("burst5Dps", Num(report.burst5_dps)),
        ("averageDps", report.average_dps.map_or(Null, Num)),
        ("sustainedDps", Num(report.sustained_dps)),
        ("ceilingDps", Num(report.ceiling_dps)),
        ("saturated", Bool(report.saturated)),
        ("landedShare", Num(r.landed_share)),
        ("hits", Num(r.claims_accepted as f64)),
        ("claimed", Num(r.claimed)),
        ("landed", Num(r.landed)),
        ("cap", Num(cap)),
        ("purseDepth", Num(report.law.depth)),
        ("purseRate", Num(report.law.rate)),
        ("hitHz", Num(report.law.hit_hz)),
        ("ref", report.law.reference.map_or(Null, Num)),
        ("immunityShare", Num(r.immunity_share)),
        ("openingS", Num(r.opening_s)),
        ("splitPenaltyS", Num(r.split_penalty_s)),
        ("phases", Num(spec.phases.len() as f64)),
    ]))
}
