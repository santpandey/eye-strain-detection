//! Composite fatigue score — 1:1 port of src/lib/analysis/fatigueScore.ts and
//! the orchestration in src/lib/analysis/scoreSession.ts.
//!
//! One explainable 0–100 number built only from the FATIGUE axis metrics —
//! task-context metrics like blink rate are deliberately excluded (screen
//! focus suppresses them regardless of tiredness). Each metric contributes a
//! saturating sub-score r/(r+K) where r is the value relative to a reference:
//! the user's own baseline median when the baseline is ready, else the
//! population 'watch' threshold (marked `estimated`).

use crate::baseline::{
    baseline_median, baseline_ready, usual_delta_pct, BaselineMetric, BaselineStats,
};
use crate::config;
use crate::session::{Confidence, QuickCheckResult};
use crate::thresholds::Status;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FatigueScoreMetric {
    Perclos,
    MeanBlinkMs,
    MeanReopenFrac,
    IncompleteRatio,
}

impl FatigueScoreMetric {
    /// QuickCheckResult JSON field name, e.g. 'meanBlinkMs'.
    pub fn as_str(self) -> &'static str {
        match self {
            FatigueScoreMetric::Perclos => "perclos",
            FatigueScoreMetric::MeanBlinkMs => "meanBlinkMs",
            FatigueScoreMetric::MeanReopenFrac => "meanReopenFrac",
            FatigueScoreMetric::IncompleteRatio => "incompleteRatio",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScorePart {
    /// QuickCheckResult field name, e.g. 'meanBlinkMs'.
    pub metric: String,
    /// Short label for delta/explain lines, e.g. 'blink length'.
    pub label: String,
    /// Config weight (already re-normalisation aware via score formula).
    pub weight: f64,
    /// Normalised 0–1 sub-score (higher = more tired).
    pub sub: f64,
    /// weight × sub — this metric's share of the score.
    pub contribution: f64,
    /// % difference vs the personal baseline median; None when not comparable.
    pub delta_pct: Option<f64>,
    /// True when anchored to population thresholds instead of the baseline.
    pub estimated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FatigueScoreOut {
    /// 0–100, or None when the session is too weak to score.
    pub score: Option<f64>,
    pub parts: Vec<ScorePart>,
    /// Whether the score was personally anchored (baseline had ≥ min sessions).
    pub baseline_ready: bool,
}

struct MetricSpec {
    metric: FatigueScoreMetric,
    baseline_key: BaselineMetric,
    label: &'static str,
    /// Population reference when no baseline: the 'watch' threshold.
    pop_ref: f64,
    weight: f64,
}

const SPECS: [MetricSpec; 4] = [
    MetricSpec {
        metric: FatigueScoreMetric::Perclos,
        baseline_key: BaselineMetric::Perclos,
        label: "eye closure",
        pop_ref: config::PERCLOS_WATCH,
        weight: config::SCORE_WEIGHT_PERCLOS,
    },
    MetricSpec {
        metric: FatigueScoreMetric::MeanBlinkMs,
        baseline_key: BaselineMetric::MeanBlinkMs,
        label: "blink length",
        pop_ref: config::MEAN_BLINK_WATCH_MS,
        weight: config::SCORE_WEIGHT_MEAN_BLINK_MS,
    },
    MetricSpec {
        metric: FatigueScoreMetric::MeanReopenFrac,
        baseline_key: BaselineMetric::MeanReopenFrac,
        label: "lid reopening",
        pop_ref: config::REOPEN_FRAC_WATCH,
        weight: config::SCORE_WEIGHT_MEAN_REOPEN_FRAC,
    },
    MetricSpec {
        metric: FatigueScoreMetric::IncompleteRatio,
        baseline_key: BaselineMetric::IncompleteRatio,
        label: "partial blinks",
        pop_ref: config::INCOMPLETE_WATCH,
        weight: config::SCORE_WEIGHT_INCOMPLETE_RATIO,
    },
];

fn status_for(r: &QuickCheckResult, m: FatigueScoreMetric) -> Status {
    match m {
        FatigueScoreMetric::Perclos => r.statuses.perclos,
        FatigueScoreMetric::MeanBlinkMs => r.statuses.mean_blink_ms,
        FatigueScoreMetric::MeanReopenFrac => r.statuses.reopen_frac,
        FatigueScoreMetric::IncompleteRatio => r.statuses.incomplete_ratio,
    }
}

fn value_of(r: &QuickCheckResult, m: FatigueScoreMetric) -> f64 {
    match m {
        FatigueScoreMetric::Perclos => r.perclos,
        FatigueScoreMetric::MeanBlinkMs => r.mean_blink_ms,
        FatigueScoreMetric::MeanReopenFrac => r.mean_reopen_frac,
        FatigueScoreMetric::IncompleteRatio => r.incomplete_ratio,
    }
}

pub fn fatigue_score(r: &QuickCheckResult, baseline: Option<&BaselineStats>) -> FatigueScoreOut {
    let ready = baseline_ready(baseline);
    let mut parts: Vec<ScorePart> = Vec::new();
    for spec in SPECS.iter() {
        if status_for(r, spec.metric) == Status::Na {
            continue;
        }
        let v = value_of(r, spec.metric);
        if !v.is_finite() {
            continue;
        }
        let med = if ready {
            baseline_median(baseline, spec.baseline_key)
        } else {
            None
        };
        let estimated = !(med.is_some_and(|m| m > 0.0));
        let reference = if estimated {
            spec.pop_ref
        } else {
            med.unwrap_or(spec.pop_ref)
        };
        let ratio = if reference > 0.0 { v / reference } else { 0.0 };
        let sub = ratio / (ratio + config::SCORE_SATURATE_K);
        parts.push(ScorePart {
            metric: spec.metric.as_str().to_string(),
            label: spec.label.to_string(),
            weight: spec.weight,
            sub,
            contribution: spec.weight * sub,
            delta_pct: usual_delta_pct(v, med),
            estimated,
        });
    }

    let events = r.complete_blinks + r.incomplete_blinks;
    let too_weak = r.confidence == Confidence::Low || events < config::SCORE_MIN_EVENTS;
    let w_sum: f64 = parts.iter().map(|p| p.weight).sum();
    let score = if too_weak || w_sum <= 0.0 {
        None
    } else {
        Some((100.0 * (parts.iter().map(|p| p.contribution).sum::<f64>() / w_sum)).round())
    };
    FatigueScoreOut {
        score,
        parts,
        baseline_ready: ready,
    }
}

/// Chip tier for a score: good < scoreWatch ≤ watch < scoreHigh ≤ high.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreTier {
    Good,
    Watch,
    High,
}

pub fn score_tier(score: f64) -> ScoreTier {
    if score >= config::SCORE_HIGH {
        ScoreTier::High
    } else if score >= config::SCORE_WATCH {
        ScoreTier::Watch
    } else {
        ScoreTier::Good
    }
}

/// What score_and_learn returns — mirrors TS ScoreView.
pub struct ScoreView {
    /// fatigue_score() output: score, explainable parts, baseline_ready.
    pub out: FatigueScoreOut,
    /// The baseline the score was compared against (pre-update snapshot).
    pub baseline: BaselineStats,
    /// Contributing sessions including this one (for "N of 3" footnotes).
    pub sessions_so_far: u32,
}

/// Attach the composite fatigue score to a fresh (non-abstained) result and
/// let the personal baseline learn from it. Must run AFTER result() and
/// BEFORE save so the stored record carries `fatigueScore`.
///
/// Order matters: the score is computed against the baseline as it was before
/// this check, then this session is folded in — otherwise the session would
/// drift the reference it is compared against. Storage failures degrade to
/// an unanchored score rather than blocking the results view.
pub fn score_and_learn(r: &mut QuickCheckResult) -> ScoreView {
    let baseline = crate::storage::get_baseline().unwrap_or_else(|_| empty_baseline_owned());
    let out = fatigue_score(r, Some(&baseline));
    if let Some(score) = out.score {
        r.fatigue_score = Some(score);
    }
    let mut sessions_so_far = baseline.sessions + 1;
    match crate::storage::update_baseline(r, Some(&baseline)) {
        Ok(updated) => sessions_so_far = updated.sessions,
        Err(_) => {
            // Baseline persistence failure → keep the optimistic count.
        }
    }
    ScoreView {
        out,
        baseline,
        sessions_so_far,
    }
}

fn empty_baseline_owned() -> BaselineStats {
    crate::baseline::empty_baseline()
}
