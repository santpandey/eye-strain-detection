//! Local persistence for the CLI: the app's IndexedDB equivalent.
//!
//! - Baseline: single JSON record at ~/.eyefd/baseline.json.
//! - History:  one QuickCheckResult JSON per line at ~/.eyefd/history.jsonl.
//!
//! Only summary metrics are ever persisted — never frames or images. Set
//! EYEFD_HOME to relocate the directory (tests).

use crate::baseline::{contribute, empty_baseline, normalize_baseline, BaselineStats};
use crate::session::QuickCheckResult;
use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    if let Ok(env) = std::env::var("EYEFD_HOME") {
        if !env.is_empty() {
            return PathBuf::from(env);
        }
    }
    directories::BaseDirs::new()
        .map(|b| b.home_dir().join(".eyefd"))
        .unwrap_or_else(|| PathBuf::from(".eyefd"))
}

fn baseline_path() -> PathBuf {
    data_dir().join("baseline.json")
}

fn history_path() -> PathBuf {
    data_dir().join("history.jsonl")
}

/// The stored baseline; an empty record when none exists yet (or unreadable).
pub fn get_baseline() -> Result<BaselineStats> {
    let raw = match fs::read_to_string(baseline_path()) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_baseline()),
        Err(e) => return Err(e).context("read baseline.json"),
    };
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    Ok(normalize_baseline(&v))
}

/// Fold a saved session into the baseline and persist it. Call only for
/// sessions that were actually saved — never abstained (low-confidence) ones.
/// Pass an already-fetched `base` to skip a redundant read.
pub fn update_baseline(
    r: &QuickCheckResult,
    base: Option<&BaselineStats>,
) -> Result<BaselineStats> {
    let owned;
    let b = match base {
        Some(b) => b,
        None => {
            owned = get_baseline()?;
            &owned
        }
    };
    let next = contribute(b, r);
    let p = baseline_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).context("create ~/.eyefd")?;
    }
    fs::write(&p, serde_json::to_string(&next)?).context("write baseline.json")?;
    Ok(next)
}

#[allow(dead_code)]
pub fn reset_baseline() -> Result<()> {
    let p = baseline_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&p, serde_json::to_string(&empty_baseline())?)?;
    Ok(())
}

/// Append one result to history.jsonl.
pub fn save_session(r: &QuickCheckResult) -> Result<()> {
    let p = history_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).context("create ~/.eyefd")?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .context("open history.jsonl")?;
    writeln!(f, "{}", serde_json::to_string(r)?).context("append history.jsonl")?;
    Ok(())
}

/// All saved results, newest first (startedAt desc — same as db.ts).
#[allow(dead_code)]
pub fn list_sessions() -> Vec<QuickCheckResult> {
    let Ok(raw) = fs::read_to_string(history_path()) else {
        return Vec::new();
    };
    let mut rows: Vec<QuickCheckResult> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    rows.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    rows
}
