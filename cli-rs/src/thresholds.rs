//! Metric statuses, headline verdict and tips — 1:1 port of
//! src/lib/analysis/thresholds.ts.

use crate::config;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Status {
    #[default]
    Good,
    Watch,
    High,
    #[serde(rename = "na")]
    Na,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Good => "good",
            Status::Watch => "watch",
            Status::High => "high",
            Status::Na => "na",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    BlinkRate,
    IncompleteRatio,
    MeanBlinkMs,
    ReopenFrac,
    Perclos,
    MaxIbiMs,
    DistanceCm,
    Luma,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricStatuses {
    pub blink_rate: Status,
    pub incomplete_ratio: Status,
    #[serde(rename = "meanBlinkMs")]
    pub mean_blink_ms: Status,
    #[serde(rename = "reopenFrac")]
    pub reopen_frac: Status,
    pub perclos: Status,
    #[serde(rename = "maxIbiMs")]
    pub max_ibi_ms: Status,
    #[serde(rename = "distanceCm")]
    pub distance_cm: Status,
    pub luma: Status,
}

impl MetricStatuses {
    pub fn get(&self, m: Metric) -> Status {
        match m {
            Metric::BlinkRate => self.blink_rate,
            Metric::IncompleteRatio => self.incomplete_ratio,
            Metric::MeanBlinkMs => self.mean_blink_ms,
            Metric::ReopenFrac => self.reopen_frac,
            Metric::Perclos => self.perclos,
            Metric::MaxIbiMs => self.max_ibi_ms,
            Metric::DistanceCm => self.distance_cm,
            Metric::Luma => self.luma,
        }
    }
}

/// Metrics that actually indicate tired/drowsy eyes vs. metrics that mostly
/// reflect the task context. Literature basis: reading/screen tasks suppress
/// blink rate within ~1 min regardless of fatigue (Tayson 2023; Argiles 2015
/// found incomplete-blink share, not rate, correlates with CVS symptoms), so a
/// low blink rate means "screen focus → dry-eye risk", not tiredness. PERCLOS,
/// blink duration and slow lid reopening are the validated drowsiness signals
/// (Wierwille 1994; Schleicher 2008).
pub const FATIGUE_METRICS: [Metric; 4] = [
    Metric::IncompleteRatio,
    Metric::MeanBlinkMs,
    Metric::ReopenFrac,
    Metric::Perclos,
];
pub const CONTEXT_METRICS: [Metric; 4] = [
    Metric::BlinkRate,
    Metric::MaxIbiMs,
    Metric::DistanceCm,
    Metric::Luma,
];

/// Headline verdict: fatigue signals outrank task-context signals.
pub fn overall_verdict(s: &MetricStatuses) -> &'static str {
    let fatigue: Vec<Status> = FATIGUE_METRICS
        .iter()
        .map(|&m| s.get(m))
        .filter(|&x| x != Status::Na)
        .collect();
    let context: Vec<Status> = CONTEXT_METRICS
        .iter()
        .map(|&m| s.get(m))
        .filter(|&x| x != Status::Na)
        .collect();
    if fatigue.contains(&Status::High) {
        return "Your eyes look tired";
    }
    if fatigue.contains(&Status::Watch) {
        return "A few things to watch";
    }
    if context.contains(&Status::High) || context.contains(&Status::Watch) {
        return "Screen-focus strain signs";
    }
    "Looking good"
}

/// The core measured values assess() thresholds against.
#[derive(Debug, Clone, Copy)]
pub struct Core {
    pub blink_rate: f64,
    pub incomplete_ratio: f64,
    pub mean_blink_ms: f64,
    pub mean_reopen_frac: f64,
    pub perclos: f64,
    pub max_ibi_ms: f64,
    pub distance_cm: f64,
    pub luma: f64,
}

pub struct Assessment {
    pub statuses: MetricStatuses,
    pub tips: Vec<String>,
}

pub fn assess(c: &Core, event_count: usize, distance_available: bool) -> Assessment {
    let statuses = MetricStatuses {
        blink_rate: if c.blink_rate < config::BLINK_RATE_HIGH_LOW
            || c.blink_rate > config::BLINK_RATE_HIGH_HIGH
        {
            Status::High
        } else if c.blink_rate < config::BLINK_RATE_WATCH_LOW
            || c.blink_rate > config::BLINK_RATE_WATCH_HIGH
        {
            Status::Watch
        } else {
            Status::Good
        },
        incomplete_ratio: if event_count < config::MIN_EVENTS_INCOMPLETE {
            Status::Na
        } else if c.incomplete_ratio > config::INCOMPLETE_HIGH {
            Status::High
        } else if c.incomplete_ratio > config::INCOMPLETE_WATCH {
            Status::Watch
        } else {
            Status::Good
        },
        mean_blink_ms: if event_count < config::MIN_EVENTS_MEAN_BLINK {
            Status::Na
        } else if c.mean_blink_ms > config::MEAN_BLINK_HIGH_MS {
            Status::High
        } else if c.mean_blink_ms > config::MEAN_BLINK_WATCH_MS {
            Status::Watch
        } else {
            Status::Good
        },
        reopen_frac: if event_count < config::MIN_EVENTS_MEAN_BLINK {
            Status::Na
        } else if c.mean_reopen_frac > config::REOPEN_FRAC_HIGH {
            Status::High
        } else if c.mean_reopen_frac > config::REOPEN_FRAC_WATCH {
            Status::Watch
        } else {
            Status::Good
        },
        perclos: if c.perclos > config::PERCLOS_HIGH {
            Status::High
        } else if c.perclos > config::PERCLOS_WATCH {
            Status::Watch
        } else {
            Status::Good
        },
        max_ibi_ms: if c.max_ibi_ms > config::IBI_HIGH_MS {
            Status::High
        } else if c.max_ibi_ms > config::IBI_WATCH_MS {
            Status::Watch
        } else {
            Status::Good
        },
        distance_cm: if !distance_available {
            Status::Na
        } else if c.distance_cm > 0.0 && c.distance_cm < config::DISTANCE_HIGH_CM {
            Status::High
        } else if c.distance_cm > 0.0 && c.distance_cm < config::DISTANCE_WATCH_CM {
            Status::Watch
        } else {
            Status::Good
        },
        luma: if c.luma > 0.0 && c.luma < config::LUMA_WATCH {
            Status::Watch
        } else {
            Status::Good
        },
    };
    Assessment {
        tips: tips_for(&statuses, c, event_count),
        statuses,
    }
}

fn tips_for(s: &MetricStatuses, c: &Core, event_count: usize) -> Vec<String> {
    let mut tips: Vec<String> = Vec::new();
    if s.blink_rate != Status::Good {
        tips.push(if c.blink_rate < config::BLINK_RATE_WATCH_LOW {
            format!(
                "Your blink rate was low ({:.0}/min). Screen focus suppresses blinking — try 10 slow, full blinks now.",
                c.blink_rate
            )
        } else {
            format!(
                "Your blink rate was high ({:.0}/min). That can signal irritation or dryness — consider lubricating drops and a short break.",
                c.blink_rate
            )
        });
    }
    if s.incomplete_ratio == Status::Na {
        // silently skipped — not enough events
    } else if s.incomplete_ratio != Status::Good {
        tips.push(
            "Many of your blinks were partial. Close your eyes fully for a second — that spreads the tear film properly."
                .to_string(),
        );
    }
    if s.mean_blink_ms != Status::Good && s.mean_blink_ms != Status::Na {
        tips.push(
            "Your blinks were slow and heavy — a classic sign of tired eyes. A short break would help."
                .to_string(),
        );
    }
    if s.reopen_frac != Status::Good && s.reopen_frac != Status::Na {
        tips.push(
            "Your eyelids were slow to reopen after blinking — a drowsiness sign. A real break beats forcing blinks."
                .to_string(),
        );
    }
    if s.perclos != Status::Good {
        tips.push(
            "Your eyes stayed closed or nearly closed for a notable share of the check. Time to rest them."
                .to_string(),
        );
    }
    if s.max_ibi_ms != Status::Good {
        tips.push(format!(
            "You went {}s without blinking at one point. Remind yourself to blink during focused work.",
            (c.max_ibi_ms / 1000.0).round()
        ));
    }
    if s.distance_cm != Status::Good && s.distance_cm != Status::Na {
        tips.push(format!(
            "You sat about {} cm from the screen. Aim for roughly 50–70 cm.",
            c.distance_cm.round()
        ));
    }
    if s.luma != Status::Good {
        tips.push(
            "The room looked dim. More ambient light (not glare on the screen) is easier on your eyes."
                .to_string(),
        );
    }
    if event_count < config::MIN_EVENTS_MEAN_BLINK {
        tips.push(
            "Very few blinks were detected — treat the detailed metrics with care.".to_string(),
        );
    }
    tips
}

pub const DISCLAIMER: &str = "Wellness guidance, not a medical diagnosis.";
