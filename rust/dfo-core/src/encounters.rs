//! Shared relay bodies and encounter-specific allowances (`src/encounters.js`).
use crate::{
    allowance::{self, Phase, BREACH_PHASES},
    analyze::boss_target,
    boss_traits::relay_traits_for,
    fight::obj,
    round::js_max,
    value::Value::{self, Arr, Bool, Null, Num, Str, Undefined},
};

pub use allowance::{ref_of as boss_ref, REF_MAX as BOSS_REF_MAX};
pub const PURSE: [(&str, f64); 4] = [
    ("depthX", allowance::DEPTH_X),
    ("rateX", allowance::RATE_X),
    ("hitCapX", allowance::HIT_CAP_X),
    ("hitHz", allowance::HIT_HZ),
];
pub const DEFAULT_ENCOUNTER: &str = "breach";
pub const ENCOUNTER_IDS: [&str; 3] = ["breach", "skyketch", "abyss"];

pub struct Encounter {
    pub id: &'static str,
    pub name: &'static str,
    pub share_x: f64,
    pub hp_x: f64,
    pub group: Option<&'static str>,
    pub mobile_type: f64,
    pub phases: Option<&'static [Phase]>,
    pub immunity: Option<(f64, &'static [&'static str])>,
    pub opening_s: Option<f64>,
    pub split: Option<Split>,
    pub calibrated: bool,
    pub note: &'static str,
}

pub struct Split {
    pub targets: [&'static str; 2],
    pub window_s: Option<f64>,
    pub at: Option<f64>,
}

pub static ENCOUNTERS: [Encounter; 3] = [
    Encounter { id: "breach", name: "Breach", share_x: 240.0, hp_x: 1.0, group: Some("daedra"), mobile_type: 31.0,
        phases: Some(&BREACH_PHASES), immunity: None, opening_s: None, split: None, calibrated: true,
        note: "Dagon's Breach: 240 s share per player, two 3 s phase shields. The capture shows extra warded Ruhn's Blade/Flame windows; the model applies only the source's 3 s shields." },
    Encounter { id: "skyketch", name: "Sky-ketch", share_x: 600.0, hp_x: 1.0, group: None, mobile_type: 36.0,
        phases: None, immunity: Some((0.178, &["tuning forks up", "The Discord"])), opening_s: Some(6.6), split: None, calibrated: true,
        note: "Sky-ketch: 600 s share per player, the same purse. One solo capture: 6.6 s opening immunity and a 35.2 s The Discord window; the other no-damage gaps are downtime." },
    Encounter { id: "abyss", name: "Abyss", share_x: 240.0, hp_x: 1.0, group: None, mobile_type: 36.0,
        phases: None, immunity: None, opening_s: None, split: Some(Split { targets: ["gold", "silver"], window_s: None, at: None }), calibrated: false,
        note: "Abyss: the clock puzzle gates access; the brass boss has phases, one of which splits it into gold and silver, and both must die close in time. The share is the shared body's 240 x ref, still to be confirmed for this boss." },
];

impl Encounter {
    pub(crate) fn spec(&self, level: f64, players: f64) -> allowance::Spec {
        allowance::allowance_spec(
            level,
            players,
            self.phases.unwrap_or_default(),
            self.opening_s.unwrap_or(0.0),
            self.immunity.map(|(share, _)| share),
        )
    }
}

pub fn encounter_by_id(id: &Value) -> Option<&'static Encounter> {
    let id = id.to_js_string().to_lowercase();
    ENCOUNTERS.iter().find(|e| e.id == id)
}

pub fn purse_of(level: &Value) -> Value {
    let law = allowance::allowance_law(level.to_number());
    obj([
        ("ref", Num(law.reference.unwrap())),
        ("depth", Num(law.depth)),
        ("rate", Num(law.rate)),
        ("cap", Num(law.cap)),
        ("hitHz", Num(law.hit_hz)),
    ])
}

pub fn encounter_target(id: &Value, level: &Value, opts: &Value) -> Value {
    let e = encounter_by_id(id).unwrap_or(&ENCOUNTERS[0]);
    let law = allowance::allowance_law(level.to_number());
    let players = match opts.get("players") {
        Undefined => 1.0,
        v => v.to_number(),
    };
    let spec = e.spec(level.to_number(), players);
    let shields = spec.phases.len() as f64;
    let shield_seconds = spec.phases.iter().fold(0.0, |sum, p| sum + p.shield_s);
    let traits = opts.get("traits");
    let traits = if traits.is_nullish() {
        Arr(relay_traits_for(&Str(e.id.into()))
            .into_iter()
            .flatten()
            .map(|t| Str(t.into()))
            .collect())
    } else {
        traits.clone()
    };
    let mut t = boss_target(&obj([
        ("level", level.clone()),
        ("group", e.group.map_or(Null, |g| Str(g.into()))),
        ("mobileType", Num(e.mobile_type)),
        ("spareGear", Bool(true)),
        (
            "health",
            Num(e.share_x * law.reference.unwrap() * e.hp_x * js_max(1.0, players.floor())),
        ),
        ("traits", traits),
        ("hitCap", Num(law.cap)),
        ("phaseShields", Num(shields)),
        // mutation: equivalent - the shipped encounters have either two shields or no shield seconds (zero divided by one or two is +0).
        ("shieldSeconds", Num(shield_seconds / js_max(1.0, shields))),
    ]))
    .expect("encounters select shipped stand-ins");
    t.set(
        "allowance",
        obj([
            ("level", level.clone()),
            ("players", Num(spec.players)),
            (
                "phases",
                Arr(spec
                    .phases
                    .iter()
                    .map(|p| obj([("at", Num(p.at)), ("shieldS", Num(p.shield_s))]))
                    .collect()),
            ),
            ("openingS", Num(spec.opening_s)),
            ("immunityShare", spec.immunity_share.map_or(Null, Num)),
        ]),
    );
    t
}
