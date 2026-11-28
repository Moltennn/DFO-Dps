//! The frozen-oracle loader's own failure modes: a missing answer, a corrupt gzip, a byte that moved behind the
//! MANIFEST's back, a wrong decoded digest, a wrong decoded size, a wrong line count and a MANIFEST with no records must
//! each fail loudly, never skip or pass. The committed answers are `rust/tests/frozen/oracle/`; this test builds damaged
//! copies in a temp directory and checks the loader's error, so it proves the checks real tests rely on without touching
//! the committed files.

mod common;

use common::oracle::{oracle_from, records_in};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// A temp directory holding a copy of the committed answer for `name` and a MANIFEST that matches it.
fn copy_of(name: &str, tag: &str) -> PathBuf {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("frozen")
        .join("oracle");
    let dir =
        std::env::temp_dir().join(format!("dfo-oracle-{tag}-{}-{}", std::process::id(), name));
    fs::remove_dir_all(&dir).ok();
    fs::create_dir_all(&dir).expect("temp dir");
    fs::copy(source.join("MANIFEST"), dir.join("MANIFEST")).expect("MANIFEST");
    fs::copy(
        source.join(format!("{name}.txt.gz")),
        dir.join(format!("{name}.txt.gz")),
    )
    .expect("answer");
    dir
}

fn manifest_line(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join("MANIFEST"))
        .expect("MANIFEST")
        .lines()
        .find(|l| l.split(' ').nth(1) == Some(name))
        .expect("this oracle's record")
        .to_owned()
}

fn rewrite(dir: &Path, name: &str, line: &str) {
    let text = fs::read_to_string(dir.join("MANIFEST")).expect("MANIFEST");
    let lines: Vec<String> = text
        .lines()
        .map(|l| {
            if l.split(' ').nth(1) == Some(name) {
                line.to_owned()
            } else {
                l.to_owned()
            }
        })
        .collect();
    fs::write(dir.join("MANIFEST"), format!("{}\n", lines.join("\n"))).expect("MANIFEST");
}

/// The committed answer's gzip and decoded bytes, and the line count its MANIFEST records.
fn answer(dir: &Path, name: &str) -> (Vec<u8>, Vec<u8>, usize) {
    let packed = fs::read(dir.join(format!("{name}.txt.gz"))).expect("answer");
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(packed.as_slice())
        .read_to_end(&mut raw)
        .expect("decode");
    let lines = fs::read_to_string(dir.join("MANIFEST"))
        .expect("MANIFEST")
        .lines()
        .find(|l| l.split(' ').nth(1) == Some(name))
        .and_then(|l| l.split(' ').nth(6))
        .expect("line count")
        .parse()
        .expect("line count");
    (packed, raw, lines)
}

/// Re-encode `raw` (gzip -9) and reseal this oracle's MANIFEST record around it, with each field overridable. The
/// defaults are the truth about `raw`, so a test names only the field it damages.
fn reseal(
    dir: &Path,
    name: &str,
    raw: &[u8],
    lines: Option<usize>,
    size: Option<usize>,
    raw_sha: Option<&str>,
) {
    let mut gz = Vec::new();
    flate2::write::GzEncoder::new(&mut gz, flate2::Compression::best())
        .write_all(raw)
        .expect("encode");
    fs::write(dir.join(format!("{name}.txt.gz")), &gz).expect("write the answer");
    let fields: Vec<String> = manifest_line(dir, name)
        .split(' ')
        .map(str::to_owned)
        .collect();
    assert_eq!(fields.len(), 7, "{fields:?}");
    let count = raw.split(|b| *b == b'\n').filter(|l| !l.is_empty()).count();
    let line = format!(
        "oracle {name} {} {} {} {} {}",
        fields[2],
        common::oracle::hex_sha256(&gz),
        raw_sha.map_or_else(|| common::oracle::hex_sha256(raw), str::to_owned),
        size.unwrap_or(raw.len()),
        lines.unwrap_or(count),
    );
    rewrite(dir, name, &line);
}

#[test]
fn the_sha256_matches_published_vectors() {
    // The loader trusts its own SHA-256 for every digest check, so the hash itself is pinned first.
    assert_eq!(
        common::oracle::hex_sha256(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        common::oracle::hex_sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn the_committed_answers_load() {
    for name in ["planner", "probe", "sidebar"] {
        let lines = common::oracle::frozen_oracle(name);
        assert!(!lines.is_empty(), "{name}: an answer with no cases");
        assert!(
            lines.iter().all(|l| !l.is_empty()),
            "{name}: no blank case lines"
        );
    }
    assert!(common::oracle::frozen_oracle("planner").len() > 100);
    assert!(common::oracle::frozen_oracle("probe").len() >= 250);
    assert!(common::oracle::frozen_oracle("sidebar").len() >= 50);
}

#[test]
fn the_planner_answer_carries_the_synthetic_book() {
    // `tools/oracle-freeze.mjs` refuses a real book at record time, but that tool needs the JS. This is the same property
    // checked from the committed answer alone: the planner's first row is `book u => <records>`, and every spell NAME in
    // it must be one of the synthetic book's (`Anvil Proof <n>`, tools/rust-synth-book.mjs). A real SPELLS.STD would put
    // the player's spell names in a committed file, so this fails before that can ship.
    const BOOK_KEYS: [&str; 20] = [
        "effects",
        "type",
        "subType",
        "durationBase",
        "durationMod",
        "durationPerLevel",
        "chanceBase",
        "chanceMod",
        "chancePerLevel",
        "magnitudeBaseLow",
        "magnitudeBaseHigh",
        "magnitudeLevelBase",
        "magnitudeLevelHigh",
        "magnitudePerLevel",
        "element",
        "rangeType",
        "cost",
        "name",
        "icon",
        "index",
    ];
    let line = common::oracle::frozen_oracle("planner")
        .into_iter()
        .find(|l| l.starts_with("book "))
        .expect("the planner oracle's first row is its spellbook");
    let mut names = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b's' {
            i += 1;
            continue;
        }
        // `s` + one or more 4-hex UTF-16 units + `;`.
        let mut at = i + 1;
        while at + 4 <= bytes.len() && bytes[at..at + 4].iter().all(u8::is_ascii_hexdigit) {
            at += 4;
        }
        if at > i + 1 && bytes.get(at) == Some(&b';') {
            let mut text = String::new();
            for unit in bytes[i + 1..at].chunks(4) {
                let hex = std::str::from_utf8(unit).expect("hex");
                let code = u16::from_str_radix(hex, 16).expect("code unit");
                text.push(char::from_u32(u32::from(code)).expect("a BMP code unit"));
            }
            names.push(text);
            i = at + 1;
        } else {
            i += 1;
        }
    }
    let spells: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|n| !BOOK_KEYS.contains(n))
        .collect();
    assert!(
        spells.len() >= 20,
        "the book row names {} spells, expected the synthetic set: {names:?}",
        spells.len()
    );
    let foreign: Vec<&&str> = spells
        .iter()
        .filter(|n| !n.starts_with("Anvil Proof "))
        .collect();
    assert!(
        foreign.is_empty(),
        "the committed planner answer carries a non-synthetic spell name (a real SPELLS.STD?): {foreign:?}"
    );
}

#[test]
fn a_missing_answer_fails_loudly() {
    let dir = copy_of("sidebar", "missing");
    fs::remove_file(dir.join("sidebar.txt.gz")).expect("remove");
    let why = oracle_from(&dir, "sidebar").expect_err("a missing answer must fail");
    assert!(why.contains("missing or unreadable"), "{why}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_corrupt_gzip_fails_loudly() {
    let dir = copy_of("sidebar", "corrupt");
    let path = dir.join("sidebar.txt.gz");
    let mut bytes = fs::read(&path).expect("answer");
    let cut = bytes.len() / 2;
    bytes.truncate(cut);
    fs::write(&path, bytes).expect("truncate");
    let why = oracle_from(&dir, "sidebar").expect_err("a corrupt answer must fail");
    assert!(
        why.contains("gzip sha256 differs") || why.contains("does not decompress"),
        "{why}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_byte_that_moved_behind_the_manifest_fails_loudly() {
    let dir = copy_of("sidebar", "edited");
    let path = dir.join("sidebar.txt.gz");
    let mut bytes = fs::read(&path).expect("answer");
    // Still a valid gzip, one decoded byte changed: decode it, flip, re-encode.
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_end(&mut raw)
        .expect("decode");
    raw[0] ^= 0x01;
    let mut gz = Vec::new();
    flate2::write::GzEncoder::new(&mut gz, flate2::Compression::best())
        .write_all(&raw)
        .expect("encode");
    bytes = gz;
    fs::write(&path, bytes).expect("rewrite");
    let why = oracle_from(&dir, "sidebar").expect_err("an edited answer must fail");
    assert!(why.contains("gzip sha256 differs"), "{why}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_short_answer_fails_loudly() {
    // Re-encode a shorter answer, then reseal the record with the COMMITTED line count: the loader must refuse on the
    // count, so a truncated recording cannot pass as a full one even when the digests and size are self-consistent.
    let dir = copy_of("sidebar", "short");
    let (_, raw, lines) = answer(&dir, "sidebar");
    let text = String::from_utf8(raw).expect("UTF-8");
    let kept: Vec<&str> = text.lines().filter(|l| !l.is_empty()).take(10).collect();
    let short = format!("{}\n", kept.join("\n"));
    reseal(&dir, "sidebar", short.as_bytes(), Some(lines), None, None);
    assert_eq!(kept.len(), 10, "the short answer is short");
    let why = oracle_from(&dir, "sidebar").expect_err("a short answer must fail");
    assert!(
        why.contains(&format!("{lines} cases recorded, 10 read")),
        "the count is the check: {why}"
    );
    // Control: the same bytes with the honest count load, so the failure above is the count and not the fixture.
    reseal(&dir, "sidebar", short.as_bytes(), Some(10), None, None);
    assert_eq!(
        oracle_from(&dir, "sidebar")
            .expect("an honest count loads")
            .len(),
        10
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_wrong_decoded_digest_fails_loudly() {
    // Every digest and size field agrees with the bytes on disk except the decoded sha256.
    let dir = copy_of("sidebar", "rawsha");
    let (_, raw, lines) = answer(&dir, "sidebar");
    reseal(
        &dir,
        "sidebar",
        &raw,
        Some(lines),
        None,
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
    );
    let why = oracle_from(&dir, "sidebar").expect_err("a wrong raw digest must fail");
    assert!(why.contains("decoded sha256 differs"), "{why}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_wrong_decoded_size_fails_loudly() {
    // Only the decoded size is wrong, so this pins that field on its own (the digest would catch a changed byte).
    let dir = copy_of("sidebar", "size");
    let (_, raw, lines) = answer(&dir, "sidebar");
    reseal(
        &dir,
        "sidebar",
        &raw,
        Some(lines),
        Some(raw.len() - 1),
        None,
    );
    let why = oracle_from(&dir, "sidebar").expect_err("a wrong decoded size must fail");
    assert!(why.contains("decoded size differs"), "{why}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_wrong_line_count_fails_loudly() {
    // The bytes and their digests are the committed ones; only the manifest's line count is one too many.
    let dir = copy_of("sidebar", "count");
    let (_, raw, lines) = answer(&dir, "sidebar");
    reseal(&dir, "sidebar", &raw, Some(lines + 1), None, None);
    let why = oracle_from(&dir, "sidebar").expect_err("a wrong line count must fail");
    assert!(
        why.contains(&format!("{} cases recorded", lines + 1)),
        "{why}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_manifest_with_no_records_fails_loudly() {
    let dir = copy_of("sidebar", "empty");
    fs::write(dir.join("MANIFEST"), "# nothing here\n").expect("MANIFEST");
    let why = records_in(&dir).expect_err("an empty MANIFEST must fail");
    assert!(why.contains("names no oracle"), "{why}");
    fs::remove_dir_all(&dir).ok();
}
