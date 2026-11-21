//! The pure helpers of `src/save.js` (R4a) against `tests/vectors/save.txt`: the inputs are character projections and item
//! lists written once as `def` lines (`@<index>` in a case), and every output is compared as the canonical token.

mod common;

use dfo_core::save::*;
use dfo_core::value::Value;
use std::collections::BTreeMap;

#[test]
fn save_helpers_match_the_js_vectors() {
    let (defs, cases) = common::load_with_defs("save");
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for mut c in cases {
        let kind = c.kind.clone();
        match kind.as_str() {
            "eff" => {
                let v = c.value(&defs);
                c.check_out("effectiveSkill", &Value::Num(effective_skill(&v)));
            }
            "msa" => {
                let ch = c.value(&defs);
                c.check_out(
                    "masterSkillsActive",
                    &Value::Bool(master_skills_active(&ch)),
                );
            }
            "mcs" => {
                let ch = c.value(&defs);
                let id = c.value(&defs);
                let raw = c.value(&defs);
                c.check_out("masterCappedSkill", &master_capped_skill(&ch, &id, &raw));
            }
            "smo" => {
                let ch = c.value(&defs);
                let id = c.value(&defs);
                c.check_out("skillModOf", &Value::Num(skill_mod_of(&ch, &id)));
            }
            "sv" => {
                let ch = c.value(&defs);
                let id = c.value(&defs);
                c.check_out("skillValue", &Value::Num(skill_value(&ch, &id)));
            }
            "ls" => {
                let ch = c.value(&defs);
                let name = match c.value(&defs).as_str() {
                    Some(s) => s.to_owned(),
                    None => c.fail("a stat name must be a string"),
                };
                c.check_out("liveStat", &Value::Num(live_stat(&ch, &name)));
            }
            "rem" => {
                let items = c.value(&defs);
                c.check_out("rebuildEnchantMods", &rebuild_enchant_mods(&items));
            }
            "rm" => {
                let items = c.value(&defs);
                c.check_out("rebuildMods", &rebuild_mods(&items));
            }
            "cl" => {
                let ch = c.value(&defs);
                c.check_out("characterLabel", &Value::Str(character_label(&ch)));
            }
            "sn" => {
                let id = c.value(&defs);
                c.check_out("skillName", &skill_name(&id));
            }
            "wsk" => {
                let id = c.value(&defs);
                let got = weapon_skill(&id).map_or(Value::Undefined, Value::Num);
                c.check_out("WEAPON_SKILL[id]", &got);
            }
            "pf" => {
                let id = c.value(&defs);
                let got = proficiency_flag(&id).map_or(Value::Undefined, Value::Num);
                c.check_out("PROFICIENCY_FLAG[id]", &got);
            }
            "cfs" => {
                let save = c.value(&defs);
                let opts = c.value(&defs);
                let save_before = dfo_core::value::write(&save);
                let opts_before = dfo_core::value::write(&opts);
                let got = character_from_save(&save, &opts);
                assert_eq!(
                    save_before,
                    dfo_core::value::write(&save),
                    "characterFromSave mutated its save"
                );
                assert_eq!(
                    opts_before,
                    dfo_core::value::write(&opts),
                    "characterFromSave mutated its options"
                );
                c.check_out("characterFromSave", &got);
            }
            "cfsa" => {
                // The analysis parity: the card the JS `analyze` answers for the character `characterFromSave` built,
                // answered by this port's own `analyze` over the character it built.
                let save = c.value(&defs);
                let opts = c.value(&defs);
                let save_before = dfo_core::value::write(&save);
                let ch = character_from_save(&save, &opts);
                assert_eq!(
                    save_before,
                    dfo_core::value::write(&save),
                    "characterFromSave mutated its save"
                );
                let book = dfo_core::spells::Spellbook::default();
                let card = dfo_core::analyze::analyze(&ch, &Value::Obj(vec![]), &book).to_value();
                c.check_out("characterFromSave + analyze", &card);
            }
            other => c.fail(&format!("unknown kind `{other}`")),
        }
        c.done();
        *seen.entry(kind).or_default() += 1;
    }
    for kind in [
        "eff", "msa", "mcs", "smo", "sv", "ls", "rem", "rm", "cl", "sn", "wsk", "pf", "cfs", "cfsa",
    ] {
        let n = seen.get(kind).copied().unwrap_or(0);
        let floor = if kind == "cfsa" { 5 } else { 2000 };
        assert!(
            n >= floor,
            "save.txt: only {n} `{kind}` cases (expected >= {floor})"
        );
    }
}
