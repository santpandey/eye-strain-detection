//! `eyefd report` — self-contained HTML dashboard of saved sessions.

use anyhow::{Context, Result};
use serde::Serialize;
use std::path::PathBuf;

const TEMPLATE: &str = include_str!("../assets/report.html");

#[derive(Serialize)]
struct Row<'a> {
    t: &'a str,
    #[serde(rename = "score")]
    score: Option<f64>,
    #[serde(rename = "blinkRate")]
    blink_rate: f64,
    partial: f64,
    perclos: f64,
    #[serde(rename = "blinkMs")]
    blink_ms: f64,
    reopen: f64,
    dist: f64,
    usable: f64,
    conf: &'a str,
}

/// Build the dashboard HTML from history, write it under ~/.eyefd and
/// return the file path.
pub fn build_report() -> Result<PathBuf> {
    let sessions = crate::storage::list_sessions();
    let rows: Vec<Row> = sessions
        .iter()
        .map(|s| Row {
            t: &s.started_at,
            score: s.fatigue_score,
            blink_rate: s.blink_rate,
            partial: s.incomplete_ratio,
            perclos: s.perclos,
            blink_ms: s.mean_blink_ms,
            reopen: s.mean_reopen_frac,
            dist: s.distance_cm,
            usable: s.quality_ms,
            conf: match s.confidence {
                crate::session::Confidence::High => "high",
                crate::session::Confidence::Medium => "med",
                crate::session::Confidence::Low => "low",
            },
        })
        .collect();
    let data = serde_json::to_string(&rows).context("serialize history")?;
    let html = TEMPLATE.replace("__DATA__", &data).replace(
        "__GEN__",
        &chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
    );
    let path = crate::storage::data_dir().join("report.html");
    std::fs::write(&path, html).with_context(|| format!("write {}", path.display()))?;
    Ok(path)
}

/// Open the report in the default browser (best-effort).
pub fn open_report(path: &PathBuf) {
    #[cfg(windows)]
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", &path.to_string_lossy()])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}
