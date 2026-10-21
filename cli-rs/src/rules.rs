//! Monitor reminder rules — port of src/lib/analysis/monitorRules.ts (logic
//! preserved via the Python reference port, cli/blinkwell/monitorRules.py).
//!
//! At most one reminder per kind is ever returned by a single evaluation.

use crate::config;
use crate::session::QuickCheckResult;
use serde::Serialize;

/// What the evaluator needs each tick.
pub struct MonitorRuleState<'a> {
    pub now: f64,
    pub monitor_on_since: f64,
    /// Wall-ms of the last completed/skipped break; None = none yet.
    pub last_break_at: Option<f64>,
    /// None when the last window abstained or none ran.
    pub last_window_result: Option<&'a QuickCheckResult>,
    pub window_count: u32,
    /// Optional override for the 20-20-20 interval.
    pub break_every_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    /// 'break' | 'tired' | 'blink'
    pub kind: String,
    pub title: String,
    pub body: String,
    /// Exercise id from exercises.rs, when one is suggested.
    pub exercise: Option<String>,
}

/// Which reminders the background monitor should surface right now.
pub fn evaluate_reminders(s: &MonitorRuleState) -> Vec<Reminder> {
    let mut out: Vec<Reminder> = Vec::new();
    let break_every_ms = s.break_every_ms.unwrap_or(config::MONITOR_BREAK_EVERY_MS);

    // 20-20-20: time since the last break (or since monitoring started).
    let break_since = s.last_break_at.unwrap_or(s.monitor_on_since);
    if s.now - break_since >= break_every_ms {
        out.push(Reminder {
            id: format!("break:{:.0}", s.now),
            kind: "break".to_string(),
            title: "Time for a 20-20-20 break".to_string(),
            body:
                "Every 20 minutes, look at something about 6 metres (20 feet) away for 20 seconds."
                    .to_string(),
            exercise: Some("look-far".to_string()),
        });
    }

    // One nudge from the latest window: a high fatigue score outranks
    // task-context signs (low blink rate / long gaps mean screen focus).
    if let Some(r) = s.last_window_result {
        if r.fatigue_score.is_some_and(|fs| fs >= config::SCORE_HIGH) {
            out.push(Reminder {
                id: format!("tired:{:.0}", s.now),
                kind: "tired".to_string(),
                title: "Your eyes look tired".to_string(),
                body: "The last check showed strong tired-eye signs. A short rest beats pushing through."
                    .to_string(),
                exercise: Some("palming".to_string()),
            });
        } else if r.statuses.blink_rate == crate::thresholds::Status::High
            || r.statuses.max_ibi_ms == crate::thresholds::Status::High
        {
            out.push(Reminder {
                id: format!("blink:{:.0}", s.now),
                kind: "blink".to_string(),
                title: "Remember to blink".to_string(),
                body: "Screen focus is suppressing your blinks — a few slow, full blinks spread the tear film."
                    .to_string(),
                exercise: Some("full-blinks".to_string()),
            });
        }
    }
    out
}
