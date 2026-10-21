//! Blink-event vs label matching — 1:1 port of src/lib/analysis/eval.ts.
//!
//! Greedy time-ordered matching: a label at t matches an unmatched detected
//! event if start − tol ≤ t ≤ end + tol.

use crate::blink::BlinkEvent;
use crate::config;
use serde::Serialize;

pub trait Span {
    fn start(&self) -> f64;
    fn end(&self) -> f64;
}

impl Span for BlinkEvent {
    fn start(&self) -> f64 {
        self.start
    }
    fn end(&self) -> f64 {
        self.end
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelMatch<'a> {
    pub t: f64,
    pub event: Option<&'a BlinkEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult<'a> {
    pub tp: usize,
    pub fp: usize,
    pub fn_: usize,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
    /// (detected/min − true/min), using the provided quality minutes.
    pub rate_error_per_min: f64,
    pub detected_count: usize,
    pub true_count: usize,
    /// Every label (time-sorted) with the event it matched, or None (miss).
    #[serde(skip)]
    pub label_matches: Vec<LabelMatch<'a>>,
    /// Detected events (start-sorted) that matched no label (false positives).
    #[serde(skip)]
    pub unmatched_events: Vec<&'a BlinkEvent>,
}

/// Greedy time-ordered matching over label times `ts` (ms).
pub fn match_blinks<'a>(
    events: &'a [BlinkEvent],
    labels: &[f64],
    quality_min: f64,
    tol_ms: Option<f64>,
) -> MatchResult<'a> {
    let tol_ms = tol_ms.unwrap_or(config::MATCH_TOL_MS);
    let mut ts: Vec<f64> = labels.to_vec();
    ts.sort_by(f64::total_cmp);
    let mut ev: Vec<&BlinkEvent> = events.iter().collect();
    ev.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut used = vec![false; ts.len()];
    let mut label_event: Vec<Option<&BlinkEvent>> = vec![None; ts.len()];
    let mut unmatched_events: Vec<&BlinkEvent> = Vec::new();
    let mut tp = 0usize;
    for e in &ev {
        let mut hit = false;
        for i in 0..ts.len() {
            if used[i] {
                continue;
            }
            if ts[i] < e.start - tol_ms {
                continue;
            }
            if ts[i] > e.end + tol_ms {
                break;
            }
            used[i] = true;
            label_event[i] = Some(e);
            hit = true;
            tp += 1;
            break;
        }
        if !hit {
            unmatched_events.push(e);
        }
    }
    let fp = ev.len() - tp;
    let fn_ = ts.len() - tp;
    let precision = if tp + fp > 0 {
        tp as f64 / (tp + fp) as f64
    } else {
        0.0
    };
    let recall = if tp + fn_ > 0 {
        tp as f64 / (tp + fn_) as f64
    } else {
        0.0
    };
    let f1 = if precision + recall > 0.0 {
        (2.0 * precision * recall) / (precision + recall)
    } else {
        0.0
    };
    MatchResult {
        tp,
        fp,
        fn_,
        precision,
        recall,
        f1,
        rate_error_per_min: if quality_min > 0.0 {
            (ev.len() as f64 - ts.len() as f64) / quality_min
        } else {
            0.0
        },
        detected_count: ev.len(),
        true_count: ts.len(),
        label_matches: ts
            .iter()
            .enumerate()
            .map(|(i, &t)| LabelMatch {
                t,
                event: label_event[i],
            })
            .collect(),
        unmatched_events,
    }
}
