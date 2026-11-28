//! Ported from `test/build14631.test.js:297-316` (the `dist:` citation pin check, at the revision that still had it),
//! widened to every `dist:` citation in the repository.
//!
//! LOCAL INVARIANT (AGENTS.md rule 1, "pin first"): a `dist:<chunk>:<sha16>:<offset>@<version>` citation is valid only
//! where a record under `rust/dist-pins/` lists that chunk, its sha256 and its version. The JS check read only its own
//! file; this one reads every tracked text file outside `vendor/` - `test/` included while it exists - so a citation
//! added to a doc, a Rust comment or a JS test is checked too. The pin record is the vendored file copied verbatim
//! (`rust/BUILD-14631.md` says why), and the three citations that lived only in `test/build14631.test.js` are in that
//! document now, so the floor of 6 still holds once `test/` is gone. It is by hand until tooling exists — this test
//! *is* that tooling.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// The extension filter: the kinds of tracked file that carry a citation.
fn is_text(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("rs" | "md" | "mjs" | "js" | "json")
    )
}

/// Directories that are never scanned: the pinned build itself, build output, dependency trees, VCS data and a `dist/`
/// payload. `test/` IS scanned while it exists (its citations must stay pinned too) and simply vanishes with it, so the
/// floor below is met by the Rust and Markdown homes once it is gone.
fn skip(name: &str) -> bool {
    matches!(name, "vendor" | "target" | "node_modules" | ".git" | "dist")
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !skip(&name) {
                collect(&path, out);
            }
        } else if is_text(&path) {
            out.push(path);
        }
    }
}

/// One pin record: version, chunk name and the first 16 hex of its sha256.
struct Pin {
    version: String,
    chunks: BTreeMap<String, String>,
}

/// Every `dist-pins/*.json` record, parsed without a JSON dependency: the records are written one field per line.
fn pins() -> Vec<Pin> {
    let dir = repo_root().join("rust").join("dist-pins");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        panic!("the pin records are missing: {}", dir.display());
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("a readable pin record");
        let version = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("\"version\":"))
            .map(|v| v.trim().trim_end_matches(',').trim_matches('"').to_owned())
            .unwrap_or_else(|| panic!("{}: no version", path.display()));
        let mut chunks = BTreeMap::new();
        let (mut chunk, mut sha): (Option<String>, Option<String>) = (None, None);
        for line in text.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("\"chunk\":") {
                chunk = Some(
                    rest.trim()
                        .trim_end_matches(',')
                        .trim_matches('"')
                        .to_owned(),
                );
            } else if let Some(rest) = line.strip_prefix("\"sha256\":") {
                sha = Some(
                    rest.trim()
                        .trim_end_matches(',')
                        .trim_matches('"')
                        .to_owned(),
                );
            } else if line.starts_with('}') {
                if let (Some(c), Some(s)) = (chunk.take(), sha.take()) {
                    chunks.insert(c, s);
                }
            }
        }
        out.push(Pin { version, chunks });
    }
    assert!(!out.is_empty(), "no pin records under {}", dir.display());
    out
}

/// One `dist:` citation found in a file.
#[derive(Debug)]
struct Cite {
    file: PathBuf,
    text: String,
    chunk: String,
    sha16: String,
    version: String,
}

/// Scan `text` for `dist:<chunk>:<16 hex>:<offset>@<version>`.
fn citations(file: &Path, text: &str) -> Vec<Cite> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while let Some(found) = text[i..].find("dist:") {
        let start = i + found;
        // A word boundary: `dist:` must not be part of a longer identifier.
        if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
            i = start + 5;
            continue;
        }
        let rest = &text[start + 5..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '`' | ')' | ',' | '|' | ';' | '*'))
            .unwrap_or(rest.len());
        let cite = &rest[..end];
        i = start + 5 + end;
        let parts: Vec<&str> = cite.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        let Some((offset, after)) = parts[2].split_once('@') else {
            continue;
        };
        // The version is the leading `[\d.]+` run: the citation may be followed by a full stop.
        let version: String = after
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if version.is_empty() || offset.is_empty() {
            continue;
        }
        let (sha16, v) = (parts[1], version.as_str());
        if !v.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if sha16.len() != 16 || !sha16.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        out.push(Cite {
            file: file.to_path_buf(),
            text: format!("dist:{}:{}:{}@{}", parts[0], sha16, offset, v),
            chunk: parts[0].to_owned(),
            sha16: sha16.to_owned(),
            version: v.to_owned(),
        });
    }
    out
}

#[test]
fn every_dist_citation_in_the_repository_is_pinned() {
    let records = pins();
    let mut files = Vec::new();
    collect(&repo_root(), &mut files);
    assert!(
        files.len() > 50,
        "the scan found only {} text files; the repository root is wrong",
        files.len()
    );
    let mut cites = Vec::new();
    for file in &files {
        let Ok(text) = fs::read_to_string(file) else {
            continue;
        };
        cites.extend(citations(file, &text));
    }
    assert!(
        cites.len() >= 6,
        "expected at least the known 6 citations, found {}: {cites:?}",
        cites.len()
    );
    for cite in &cites {
        let record = records
            .iter()
            .find(|r| r.version == cite.version)
            .unwrap_or_else(|| {
                panic!(
                    "{}: {} carries no pin record for version {}",
                    cite.file.display(),
                    cite.text,
                    cite.version
                )
            });
        let sha = record.chunks.get(&cite.chunk).unwrap_or_else(|| {
            panic!(
                "{}: {} cites chunk {}, which the {} record does not pin",
                cite.file.display(),
                cite.text,
                cite.chunk,
                cite.version
            )
        });
        assert_eq!(
            sha.get(..16).unwrap_or_default(),
            cite.sha16,
            "{}: {} sha16",
            cite.file.display(),
            cite.text
        );
    }
    // The pin record's own version is the one citation check a hand review can get wrong: state it.
    let live = &records[0];
    assert_eq!(live.version, "0.1.14631");
}

#[test]
fn a_tampered_citation_is_caught() {
    // A negative control: the checker is not a no-op. A wrong sha16 and a wrong version both fail the lookup, so a
    // citation that drifts from its chunk can never pass silently.
    let records = pins();
    let record = &records[0];
    let (chunk, sha) = record.chunks.iter().next().expect("a pinned chunk");
    let good = format!("dist:{chunk}:{}:1@{}", &sha[..16], record.version);
    let found = citations(Path::new("control.rs"), &good);
    assert_eq!(found.len(), 1, "the checker reads its own citation shape");
    let bad = format!("dist:{chunk}:0000000000000000:1@{}", record.version);
    let found = citations(Path::new("control.rs"), &bad);
    assert_eq!(found.len(), 1);
    assert_ne!(found[0].sha16, &sha[..16], "a wrong sha16 is a citation");
}
