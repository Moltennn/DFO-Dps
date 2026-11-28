// The committed answers of the three dfo-core JS oracles, replayed without Node.
//
// `tests/planner_oracle.mjs`, `tests/probe_oracle.mjs` and `tests/sidebar_oracle.mjs` were run while the JavaScript
// (`src/`, `vendor/`, the scripts) still existed; their stdout is stored gzip -9 in `rust/tests/frozen/oracle/` and
// pinned by that directory's MANIFEST (gzip sha256, raw sha256, size and line count). `tools/oracle-freeze.mjs`
// records the answers and `--check` re-runs the live JS against them.
//
// `DFO_CORE_ORACLE=live` makes a test spawn the script again (the differential while the JS exists); the default reads
// the frozen answer, so the suite needs no Node. A missing file, a corrupt gzip, a digest or count mismatch, or a short
// answer is a hard failure, never a skip.

use std::fs;
use std::io::Read;
use std::process::Command;

/// The repository root: this crate lives at `<repo>/rust/dfo-core`.
fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn oracle_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("frozen")
        .join("oracle")
}

/// One `oracle` record of the MANIFEST.
#[derive(Debug)]
pub struct Record {
    script: String,
    gzip_sha: String,
    raw_sha: String,
    raw_bytes: usize,
    lines: usize,
}

fn records() -> Vec<(String, Record)> {
    records_in(&oracle_dir()).unwrap_or_else(|why| panic!("{why}"))
}

/// SHA-256 (FIPS 180-4); `frozen_oracle.rs` pins it to two published vectors.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state = H0;
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&(data.len() as u64).wrapping_mul(8).to_be_bytes());
    for chunk in message.chunks(64) {
        let mut words = [0u32; 64];
        for (i, word) in words.iter_mut().take(16).enumerate() {
            let at = 4 * i;
            *word = u32::from_be_bytes([chunk[at], chunk[at + 1], chunk[at + 2], chunk[at + 3]]);
        }
        for i in 16..64 {
            let s0 = words[i - 15].rotate_right(7)
                ^ words[i - 15].rotate_right(18)
                ^ (words[i - 15] >> 3);
            let s1 = words[i - 2].rotate_right(17)
                ^ words[i - 2].rotate_right(19)
                ^ (words[i - 2] >> 10);
            words[i] = words[i - 16]
                .wrapping_add(s0)
                .wrapping_add(words[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(words[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *s = s.wrapping_add(v);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `sha256` as lowercase hex, for a test that reseals a MANIFEST around a damaged answer.
pub fn hex_sha256(bytes: &[u8]) -> String {
    hex(&sha256(bytes))
}

/// [`records`] from an explicit directory, so a test can prove the loader's failures without touching the committed
/// answers.
pub fn records_in(dir: &std::path::Path) -> Result<Vec<(String, Record)>, String> {
    let path = dir.join("MANIFEST");
    let text = fs::read_to_string(&path).map_err(|e| {
        format!(
            "frozen oracle MANIFEST missing or unreadable: {} ({e})",
            path.display()
        )
    })?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split(' ').collect();
        let ["oracle", name, script, gzip_sha, raw_sha, raw_bytes, lines] = f.as_slice() else {
            return Err(format!(
                "oracle MANIFEST:{}: unrecognised line `{line}`",
                i + 1
            ));
        };
        let number = |v: &str| {
            v.parse::<usize>()
                .map_err(|_| format!("oracle MANIFEST:{}: bad count `{v}`", i + 1))
        };
        out.push((
            (*name).to_owned(),
            Record {
                script: (*script).to_owned(),
                gzip_sha: (*gzip_sha).to_owned(),
                raw_sha: (*raw_sha).to_owned(),
                raw_bytes: number(raw_bytes)?,
                lines: number(lines)?,
            },
        ));
    }
    if out.is_empty() {
        return Err(format!(
            "oracle MANIFEST {} names no oracle",
            path.display()
        ));
    }
    Ok(out)
}

/// [`frozen_oracle`] from an explicit directory, returning the reason instead of panicking.
pub fn oracle_from(dir: &std::path::Path, name: &str) -> Result<Vec<String>, String> {
    let (_, record) = records_in(dir)?
        .into_iter()
        .find(|(n, _)| n == name)
        .ok_or_else(|| format!("oracle MANIFEST names no oracle `{name}`"))?;
    let path = dir.join(format!("{name}.txt.gz"));
    let packed = fs::read(&path).map_err(|e| {
        format!(
            "frozen oracle missing or unreadable: {} ({e})",
            path.display()
        )
    })?;
    if hex(&sha256(&packed)) != record.gzip_sha {
        return Err(format!(
            "{}.txt.gz: gzip sha256 differs from the oracle MANIFEST",
            name
        ));
    }
    let mut gz = flate2::read::GzDecoder::new(&packed[..]);
    let mut raw = Vec::new();
    gz.read_to_end(&mut raw)
        .map_err(|e| format!("{name}.txt.gz does not decompress: {e}"))?;
    if hex(&sha256(&raw)) != record.raw_sha {
        return Err(format!(
            "{name}: decoded sha256 differs from the oracle MANIFEST"
        ));
    }
    if raw.len() != record.raw_bytes {
        return Err(format!(
            "{name}: decoded size differs from the oracle MANIFEST"
        ));
    }
    let text = String::from_utf8(raw).map_err(|e| format!("{name}: answer is not UTF-8: {e}"))?;
    let lines: Vec<String> = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    if lines.len() != record.lines {
        return Err(format!(
            "{name}: {} cases recorded, {} read",
            record.lines,
            lines.len()
        ));
    }
    Ok(lines)
}

/// The recorded answer of `name`: verified against the MANIFEST, decoded, and every non-empty line returned.
pub fn frozen_oracle(name: &str) -> Vec<String> {
    oracle_from(&oracle_dir(), name).unwrap_or_else(|why| {
        panic!(
            "{why}. The committed answers are rust/tests/frozen/oracle; re-record them with `node \
             tools/oracle-freeze.mjs` while the JS exists."
        )
    })
}

/// The live script's answer (`DFO_CORE_ORACLE=live`): a missing `node` fails the test, never skips it.
pub fn live_oracle(script: &str) -> Vec<String> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(script);
    let out = Command::new("node")
        .arg(&path)
        .current_dir(repo_root())
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "DFO_CORE_ORACLE=live needs node to run {path:?}: {e}; unset it to replay the frozen answers"
            )
        });
    assert_eq!(
        out.status.code(),
        Some(0),
        "oracle {path:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .unwrap_or_else(|e| panic!("{}: answer is not UTF-8: {e}", path.display()))
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// One oracle's lines: the committed answer by default, the live JS under `DFO_CORE_ORACLE=live` (or `frozen` to force
/// the committed one). An unknown value fails loudly rather than silently choosing a tier.
pub fn oracle_lines(name: &str, script: &str) -> Vec<String> {
    match std::env::var("DFO_CORE_ORACLE").ok().as_deref() {
        None | Some("frozen") => frozen_oracle(name),
        Some("live") => live_oracle(script),
        Some(other) => panic!("DFO_CORE_ORACLE={other:?}: expected `frozen` or `live`"),
    }
}
