//! The snapshot store itself: a recorded call replays with nothing in `PATH`, and a perturbed snapshot fails.
//!
//! Local invariant, not an oracle check: the "oracle" here is a fixed shell line, so no Node and no committed snapshot
//! is needed. `the_inner_differential` is the call under test; the outer test runs this binary again to record it into
//! a temp directory and then to replay damaged copies.

mod common;

use common::{js_custom, sha256_hex, temp_root};

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};

const ANSWER: &str = "the oracle answer";
const PAGE: &str = "<!doctype html>the oracle page";

/// A differential in miniature: the "JS" prints an answer and writes a page, the "Rust" side is the constants. It runs
/// only when the outer test asks for it (`SNAPSHOT_INNER`), so ordinary and recording runs store nothing for it.
#[test]
fn the_inner_differential() {
    let Some(rust_says) = std::env::var_os("SNAPSHOT_INNER") else {
        return;
    };
    let root = temp_root("inner");
    let line = format!("printf '%s' '{ANSWER}'; printf '%s' '{PAGE}' > page.html");
    let want = js_custom(&root, &root, &["card", "--out", "page.html"], &[], &|| {
        Command::new("/bin/sh")
            .args(["-c", &line])
            .current_dir(&root)
            .output()
            .expect("the shell oracle runs")
    });
    assert_eq!(want.status.code(), Some(0), "exit");
    assert_eq!(
        String::from_utf8_lossy(&want.stdout),
        rust_says.to_string_lossy(),
        "stdout"
    );
    assert_eq!(
        fs::read_to_string(root.join("page.html")).expect("page"),
        PAGE
    );
    fs::remove_dir_all(&root).expect("cleanup");
}

/// This binary again, running only the inner differential, with no `PATH` at all.
fn inner(mode: &str, snapshots: &Path, answer: &str) -> Output {
    Command::new(std::env::current_exe().expect("this test binary"))
        .args(["--exact", "the_inner_differential", "--nocapture"])
        .env("PATH", "")
        .env("SNAPSHOT_INNER", answer)
        .env("DFO_ORACLE", mode)
        .env("DFO_SNAPSHOT_DIR", snapshots)
        .env("DFO_SNAPSHOT_STAGE", snapshots.join("stage"))
        .env_remove("DFO_ORACLE_STATS")
        .output()
        .expect("the inner test runs")
}

/// The manifest line `tools/snapshots.mjs` writes, for `bytes`.
fn seal(dir: &Path, bytes: &[u8]) {
    fs::write(dir.join("snapshot_replay.snap"), bytes).expect("snapshot");
    let sum = sha256_hex(bytes);
    fs::write(
        dir.join("MANIFEST"),
        format!("snapshot_replay.snap {sum} 1\n"),
    )
    .expect("manifest");
}

fn fails_with(dir: &Path, answer: &str, why: &str) {
    let out = inner("snapshot", dir, answer);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!out.status.success(), "replay passed, expected: {why}");
    assert!(text.contains(why), "expected `{why}` in:\n{text}");
}

#[test]
fn a_perturbed_snapshot_byte_fails_the_replay() {
    let dir = temp_root("snapshots");
    let recorded = inner("record", &dir, ANSWER);
    assert!(
        recorded.status.success(),
        "record: {}",
        String::from_utf8_lossy(&recorded.stdout)
    );
    let bytes = fs::read(
        dir.join("stage")
            .join("snapshot_replay")
            .join("the_inner_differential.part"),
    )
    .expect("the recorded part");
    let text = String::from_utf8(bytes.clone()).expect("a text snapshot");
    assert!(text.contains(ANSWER) && text.contains(PAGE), "{text}");

    seal(&dir, &bytes);
    let clean = inner("snapshot", &dir, ANSWER);
    assert!(
        clean.status.success(),
        "clean replay: {}",
        String::from_utf8_lossy(&clean.stdout)
    );

    // The committed files are gzip -9 and the digest is over those bytes: a gzipped file replays identically.
    let mut gz = Vec::new();
    flate2::write::GzEncoder::new(&mut gz, flate2::Compression::best())
        .write_all(&bytes)
        .expect("gzip the snapshot");
    seal(&dir, &gz);
    let clean = inner("snapshot", &dir, ANSWER);
    assert!(
        clean.status.success(),
        "gzipped replay: {}",
        String::from_utf8_lossy(&clean.stdout)
    );
    seal(&dir, &bytes);

    // One byte changed behind the manifest's back.
    let edited = text.replace(ANSWER, "the oracle answeR");
    fs::write(dir.join("snapshot_replay.snap"), &edited).expect("edit");
    fails_with(&dir, ANSWER, "does not match its MANIFEST digest");

    // The same byte with the manifest re-sealed: the comparison itself catches it, in the output and in a page.
    seal(&dir, edited.as_bytes());
    fails_with(&dir, ANSWER, "stdout");
    seal(
        &dir,
        text.replace("the oracle page", "the oracle pagE")
            .as_bytes(),
    );
    fails_with(&dir, ANSWER, "assertion `left == right` failed");

    // New inputs may not be served an old answer, and a missing call is not a pass.
    seal(&dir, text.replace("--out", "--oup").as_bytes());
    fails_with(&dir, ANSWER, "the argv moved");
    seal(
        &dir,
        text.replace("inner_differential 0", "inner_differential 1")
            .as_bytes(),
    );
    fails_with(
        &dir,
        ANSWER,
        "no snapshot for the_inner_differential call 0",
    );
    fs::remove_dir_all(&dir).expect("cleanup");
}
