//! Personal baseline — 1:1 port of src/lib/analysis/baseline.ts.
//!
//! A robust central estimate of each tracked metric, learned only from saved
//! (non-abstained) checks on this device: a per-metric sliding reservoir of
//! the last BASELINE_RESERVOIR session values + median. Pure functions —
//! persistence lives in storage.rs.

use crate::config;
use crate::session::QuickCheckResult;
use crate::thresholds::{Metric, Status};
use serde::{Deserialize, Serialize};

/// Metrics the baseline tracks: the fatigue axis + blinkRate (context delta).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaselineMetric {
    BlinkRate,
    MeanBlinkMs,
    MeanReopenFrac,
    Perclos,
    IncompleteRatio,
}

pub const BASELINE_METRICS: [BaselineMetric; 5] = [
    BaselineMetric::BlinkRate,
    BaselineMetric::MeanBlinkMs,
    BaselineMetric::MeanReopenFrac,
    BaselineMetric::Perclos,
    BaselineMetric::IncompleteRatio,
];

impl BaselineMetric {
    /// The JSON/TS field name.
    pub fn as_str(self) -> &'static str {
        match self {
            BaselineMetric::BlinkRate => "blinkRate",
            BaselineMetric::MeanBlinkMs => "meanBlinkMs",
            BaselineMetric::MeanReopenFrac => "meanReopenFrac",
            BaselineMetric::Perclos => "perclos",
            BaselineMetric::IncompleteRatio => "incompleteRatio",
        }
    }
}

/// Per-metric reservoirs of session values, oldest → newest. Fixed field set
/// keeps the JSON shape identical to the TS record.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaselineSamples {
    pub blink_rate: Vec<f64>,
    pub mean_blink_ms: Vec<f64>,
    pub mean_reopen_frac: Vec<f64>,
    pub perclos: Vec<f64>,
    pub incomplete_ratio: Vec<f64>,
}

impl BaselineSamples {
    pub fn get(&self, m: BaselineMetric) -> &Vec<f64> {
        match m {
            BaselineMetric::BlinkRate => &self.blink_rate,
            BaselineMetric::MeanBlinkMs => &self.mean_blink_ms,
            BaselineMetric::MeanReopenFrac => &self.mean_reopen_frac,
            BaselineMetric::Perclos => &self.perclos,
            BaselineMetric::IncompleteRatio => &self.incomplete_ratio,
        }
    }

    fn get_mut(&mut self, m: BaselineMetric) -> &mut Vec<f64> {
        match m {
            BaselineMetric::BlinkRate => &mut self.blink_rate,
            BaselineMetric::MeanBlinkMs => &mut self.mean_blink_ms,
            BaselineMetric::MeanReopenFrac => &mut self.mean_reopen_frac,
            BaselineMetric::Perclos => &mut self.perclos,
            BaselineMetric::IncompleteRatio => &mut self.incomplete_ratio,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaselineStats {
    pub version: i32, // 1
    /// Number of saved sessions that have contributed.
    pub sessions: u32,
    /// Per-metric reservoirs of session values, oldest → newest.
    pub samples: BaselineSamples,
}

pub fn empty_baseline() -> BaselineStats {
    BaselineStats {
        version: 1,
        sessions: 0,
        samples: BaselineSamples::default(),
    }
}

/// Defensive normalization of whatever came back out of the JSON file —
/// same rules as TS normalizeBaseline.
pub fn normalize_baseline(raw: &serde_json::Value) -> BaselineStats {
    let mut b = empty_baseline();
    let Some(r) = raw.as_object() else {
        return b;
    };
    if let Some(s) = r.get("sessions").and_then(|v| v.as_f64()) {
        if s >= 0.0 {
            b.sessions = s.floor() as u32;
        }
    }
    if let Some(samples) = r.get("samples").and_then(|v| v.as_object()) {
        for m in BASELINE_METRICS {
            if let Some(arr) = samples.get(m.as_str()).and_then(|v| v.as_array()) {
                let vals: Vec<f64> = arr
                    .iter()
                    .filter_map(|v| v.as_f64())
                    .filter(|v| v.is_finite())
                    .collect();
                let keep = config::BASELINE_RESERVOIR;
                *b.samples.get_mut(m) = vals[vals.len().saturating_sub(keep)..].to_vec();
            }
        }
    }
    b
}

/// baselineReady = enough contributing sessions (BASELINE_MIN_SESSIONS).
pub fn baseline_ready(b: Option<&BaselineStats>) -> bool {
    b.map(|b| b.sessions).unwrap_or(0) >= config::BASELINE_MIN_SESSIONS
}

/// Robust central estimate; None when the metric has no samples.
pub fn baseline_median(b: Option<&BaselineStats>, metric: BaselineMetric) -> Option<f64> {
    let xs = b?.samples.get(metric);
    if xs.is_empty() {
        return None;
    }
    let mut s = xs.clone();
    s.sort_by(f64::total_cmp);
    let mid = s.len() / 2;
    Some(if s.len() % 2 == 1 {
        s[mid]
    } else {
        (s[mid - 1] + s[mid]) / 2.0
    })
}

/// Signed % difference of `value` vs a baseline median; None when not
/// comparable.
pub fn usual_delta_pct(value: f64, median: Option<f64>) -> Option<f64> {
    let median = median?;
    if !median.is_finite() || !value.is_finite() {
        return None;
    }
    if median == 0.0 {
        return if value == 0.0 { Some(0.0) } else { None };
    }
    Some(((value - median) / median) * 100.0)
}

/// Short signed label for a deltaPct, e.g. '−38%', '+12%', '>10×' for extremes.
pub fn delta_text(pct: f64) -> String {
    if !pct.is_finite() {
        return "—".to_string();
    }
    if pct >= 1000.0 {
        return ">10×".to_string();
    }
    if pct <= -100.0 {
        return "−100%".to_string();
    }
    let rounded = pct.round();
    if rounded > 0.0 {
        format!("+{:.0}%", rounded)
    } else if rounded < 0.0 {
        format!("−{:.0}%", rounded.abs())
    } else {
        "0%".to_string()
    }
}

/// Which status entry (if any) can mark a baseline metric 'na' for a session.
fn status_key(m: BaselineMetric) -> Option<Metric> {
    match m {
        BaselineMetric::BlinkRate => None, // always measured when there is usable footage
        BaselineMetric::MeanBlinkMs => Some(Metric::MeanBlinkMs),
        BaselineMetric::MeanReopenFrac => Some(Metric::ReopenFrac),
        BaselineMetric::Perclos => None, // perclos is never 'na' — 0 is a real measurement
        BaselineMetric::IncompleteRatio => Some(Metric::IncompleteRatio),
    }
}

fn result_value(r: &QuickCheckResult, m: BaselineMetric) -> f64 {
    match m {
        BaselineMetric::BlinkRate => r.blink_rate,
        BaselineMetric::MeanBlinkMs => r.mean_blink_ms,
        BaselineMetric::MeanReopenFrac => r.mean_reopen_frac,
        BaselineMetric::Perclos => r.perclos,
        BaselineMetric::IncompleteRatio => r.incomplete_ratio,
    }
}

/// Fold one saved session into the baseline (returns a new record). Call only
/// for sessions that were actually saved — never abstained (low-confidence)
/// ones. A metric's value is skipped when the session couldn't measure it
/// (status 'na'), it isn't finite, or there was no usable footage at all.
pub fn contribute(b: &BaselineStats, r: &QuickCheckResult) -> BaselineStats {
    let mut next = BaselineStats {
        version: 1,
        sessions: b.sessions + 1,
        samples: b.samples.clone(),
    };
    let cap = config::BASELINE_RESERVOIR;
    for m in BASELINE_METRICS {
        if let Some(key) = status_key(m) {
            if r.statuses.get(key) == Status::Na {
                continue;
            }
        }
        let v = result_value(r, m);
        if !v.is_finite() {
            continue;
        }
        if m == BaselineMetric::BlinkRate && r.quality_ms <= 0.0 {
            continue;
        }
        let arr = next.samples.get_mut(m);
        arr.push(v);
        if arr.len() > cap {
            let overflow = arr.len() - cap;
            arr.drain(..overflow);
        }
    }
    next
}
