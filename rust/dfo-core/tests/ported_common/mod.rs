//! Fixtures for the ported local tests (`rust/PORTED-TESTS.md`), mirroring `test/harness/fixtures.mjs`.
//!
//! A fixture is a plain description; [`Desc::sim`] turns it into the character the core reads, exactly as
//! `simCharacter` does through `save.js`/`character_from_save`. Nothing here is measured.

#![allow(dead_code)]

use dfo_core::analyze::{self, Analysis};
use dfo_core::spells::Spellbook;
pub use dfo_core::value::Value;
pub use dfo_core::value::Value::{Arr, Bool, Null, Num, Obj, Str};

pub fn obj(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Obj(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

pub fn n(v: f64) -> Value {
    Num(v)
}

pub fn s(v: &str) -> Value {
    Str(v.into())
}

pub fn b(v: bool) -> Value {
    Bool(v)
}

pub fn arr(v: Vec<Value>) -> Value {
    Arr(v)
}

pub fn nums(v: impl IntoIterator<Item = f64>) -> Value {
    Arr(v.into_iter().map(Num).collect())
}

pub fn near(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9
}

pub fn near_eps(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() <= eps
}

/// A deterministic LCG for the sweeps (rule 9: no ambient randomness; this is test-local, not the ported PRNG).
pub fn lcg(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

/// A character description (`harness/fixtures.mjs` `character()`), with JS defaults.
#[derive(Clone)]
pub struct Desc {
    pub level: f64,
    pub race_id: f64,
    pub stats: [(f64, f64); 8],
    pub skills: Vec<f64>,
    pub career: [f64; 3],
    pub martial_path: Value,
    pub mastered: Vec<f64>,
    pub master_skills: bool,
    pub online: bool,
}

pub const STAT_KEYS: [&str; 8] = [
    "strength",
    "intelligence",
    "willpower",
    "agility",
    "endurance",
    "personality",
    "speed",
    "luck",
];

impl Default for Desc {
    fn default() -> Self {
        Desc {
            level: 30.0,
            race_id: 1.0,
            stats: [(0.0, 50.0); 8],
            skills: vec![40.0; 35],
            career: [0.0; 3],
            martial_path: Null,
            mastered: Vec::new(),
            master_skills: false,
            online: false,
        }
    }
}

impl Desc {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn level(mut self, level: f64) -> Self {
        self.level = level;
        self
    }

    pub fn race(mut self, race_id: f64) -> Self {
        self.race_id = race_id;
        self
    }

    pub fn stat(mut self, name: &str, value: f64) -> Self {
        let i = STAT_KEYS.iter().position(|k| *k == name).expect("a stat");
        self.stats[i] = (0.0, value);
        self
    }

    pub fn skills(mut self, value: f64) -> Self {
        self.skills = vec![value; 35];
        self
    }

    pub fn skill(mut self, id: usize, value: f64) -> Self {
        self.skills[id] = value;
        self
    }

    pub fn mastered(mut self, ids: &[f64]) -> Self {
        self.mastered = ids.to_vec();
        self
    }

    pub fn master_skills(mut self, yes: bool) -> Self {
        self.master_skills = yes;
        self
    }

    pub fn online(mut self, yes: bool) -> Self {
        self.online = yes;
        self
    }

    pub fn career(mut self, weapon_armor_shields: f64) -> Self {
        self.career[0] = weapon_armor_shields;
        self
    }

    /// `simCharacter(desc, item)`: the save import path (`src/save.js:244-306`).
    pub fn sim(&self, item: Option<Value>) -> Value {
        let stats = obj(STAT_KEYS
            .iter()
            .enumerate()
            .map(|(i, k)| (*k, Num(self.stats[i].1))));
        let save = obj([
            ("name", s("fixture")),
            ("level", Num(self.level)),
            ("raceId", Num(self.race_id)),
            ("race", s("fixture")),
            ("stats", stats),
            ("skills", nums(self.skills.iter().copied())),
            ("health", Num(100.0)),
            ("maxHealth", Num(100.0)),
            ("reflexes", Num(2.0)),
            (
                "career",
                obj([
                    ("weaponArmorShieldsBitfield", Num(self.career[0])),
                    ("abilityFlagsAndSpellPointsBitfield", Num(self.career[1])),
                    ("attackModifierFlags", Num(self.career[2])),
                ]),
            ),
            ("items", Arr(item.into_iter().collect())),
            ("activeEffects", Arr(vec![])),
            ("masterSkills", Bool(self.master_skills)),
            ("masteredSkills", nums(self.mastered.iter().copied())),
            ("martialPath", self.martial_path.clone()),
            (
                "_mods",
                obj([
                    ("stats", Obj(vec![])),
                    ("skills", Obj(vec![])),
                    ("statMax", Obj(vec![])),
                ]),
            ),
            (
                "_enchantMods",
                obj([("skillMods", Obj(vec![])), ("chanceToHitMod", Num(0.0))]),
            ),
        ]);
        dfo_core::save::character_from_save(&save, &obj([("online", Bool(self.online))]))
    }
}

/// `weapon(templateIndex, { material, condition })` (`harness/upstream.mjs` `weaponItem` + fixtures' slot).
pub fn weapon(template: f64, material: f64, condition: f64) -> Value {
    obj([
        ("group", s("Weapons")),
        ("templateIndex", Num(template)),
        ("material", Num(material)),
        ("name", s(&format!("template {template}"))),
        ("flags", Num(0.0)),
        ("maxCondition", Num(1000.0)),
        ("currentCondition", Num((1000.0 * condition).round())),
        ("equipSlot", Num(19.0)),
    ])
}

/// A weapon at an exact condition percentage (`test/condition.test.js` `at()`).
pub fn weapon_at(template: f64, pct: f64, material: f64) -> Value {
    let mut item = weapon(template, material, 1.0);
    item.set("maxCondition", Num(1000.0));
    item.set("currentCondition", Num((pct * 10.0).round()));
    item
}

pub fn book() -> Spellbook {
    Spellbook::default()
}

pub fn analyze(ch: &Value, args: &Value) -> Analysis {
    analyze::analyze(ch, args, &book())
}

pub fn reference_foe(level: f64, preset: &str) -> Value {
    analyze::reference_foe(&Num(level), &s(preset))
}

pub fn gate_target(level: f64) -> Value {
    analyze::gate_target(&Num(level), &Value::Undefined)
}

pub fn f(v: &Value) -> f64 {
    v.to_number()
}

/// `Math.round` for the fixture builders (half away from zero, as JS).
pub fn round(v: f64) -> f64 {
    v.round()
}
