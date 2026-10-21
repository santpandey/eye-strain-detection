//! Aggregates frames into a QuickCheckResult — 1:1 port of
//! src/lib/analysis/session.ts. The result is also the JSON output/history
//! format (same field names).

use crate::blink::BlinkDetector;
use crate::config;
use crate::features::{estimate_distance_cm, FrameFeatures};
use crate::quality::QualityCtx;
use crate::thresholds::{assess, Core, MetricStatuses};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfidenceReason {
    pub text: String,
    pub fix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Camera,
    File,
    Monitor,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Camera => "camera",
            Source::File => "file",
            Source::Monitor => "monitor",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCheckResult {
    pub schema_version: i32, // 2
    pub id: String,
    pub started_at: String,
    pub duration_ms: f64,
    pub quality_ms: f64,
    pub quality_pct: f64,
    pub blink_rate: f64,
    pub blink_rate_low: f64,
    pub blink_rate_high: f64,
    pub complete_blinks: usize,
    pub incomplete_blinks: usize,
    pub incomplete_ratio: f64,
    pub mean_blink_ms: f64,
    /// Mean share of each blink's closed time spent reopening (0–1).
    pub mean_reopen_frac: f64,
    pub long_closures: usize,
    pub perclos: f64,
    pub max_ibi_ms: f64,
    pub ibi_over10s: usize,
    pub distance_cm: f64,
    pub luma: f64,
    pub squint: f64,
    pub yawns: usize,
    pub fps_mean: f64,
    pub glare_pct: f64,
    pub backlit_pct: f64,
    pub gaze_down_discards: usize,
    pub asymmetric_discards: usize,
    pub confidence: Confidence,
    pub confidence_reasons: Vec<ConfidenceReason>,
    pub tips: Vec<String>,
    pub statuses: MetricStatuses,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_report: Option<f64>,
    /// Composite fatigue score 0–100, attached after result() (needs the
    /// personal baseline from storage).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatigue_score: Option<f64>,
}

/// Wilson–Hilferty Poisson 95% interval for a count.
pub fn poisson_interval(n: usize) -> (f64, f64) {
    let z = 1.96;
    let nf = n as f64;
    let lower = if n == 0 {
        0.0
    } else {
        nf * (1.0 - 1.0 / (9.0 * nf) - z / (3.0 * nf.sqrt())).powi(3)
    };
    let np1 = nf + 1.0;
    let upper = np1 * (1.0 - 1.0 / (9.0 * np1) + z / (3.0 * np1.sqrt())).powi(3);
    (lower, upper)
}

fn iso_now() -> String {
    // Same shape as `new Date().toISOString()` — millis + 'Z'.
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Per-frame quality verdict record (trace tooling).
#[derive(Debug, Clone)]
pub struct TraceDiag {
    pub ok: bool,
    pub reasons: Vec<String>,
    pub glare: bool,
    pub backlit: bool,
    pub fps: f64,
}

/// Aggregates frames into a QuickCheckResult. Pure and synchronous.
#[derive(Debug)]
pub struct QuickCheckAggregator {
    pub detector: BlinkDetector,
    pub quality: QualityCtx,
    /// Dev-mode trace of every processed frame (eyeContour stripped).
    pub trace_frames: Vec<FrameFeatures>,
    /// Dev-mode per-frame quality verdicts, aligned with traceFrames.
    pub trace_diag: Vec<TraceDiag>,
    pub trace_enabled: bool,

    pub started_at: Option<String>,
    first_t: Option<f64>,
    last_t: Option<f64>,
    distances: Vec<f64>,
    lumas: Vec<f64>,
    squints: Vec<f64>,
    jaw_since: Option<f64>,
    yawn_count: usize,
    glare_frames: usize,
    backlit_frames: usize,
    face_frames: usize,
}

impl Default for QuickCheckAggregator {
    fn default() -> Self {
        QuickCheckAggregator {
            detector: BlinkDetector::new(),
            quality: QualityCtx::new(),
            trace_frames: Vec::new(),
            trace_diag: Vec::new(),
            trace_enabled: false,
            started_at: None,
            first_t: None,
            last_t: None,
            distances: Vec::new(),
            lumas: Vec::new(),
            squints: Vec::new(),
            jaw_since: None,
            yawn_count: 0,
            glare_frames: 0,
            backlit_frames: 0,
            face_frames: 0,
        }
    }
}

impl QuickCheckAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&mut self) {
        self.started_at = Some(iso_now());
    }

    /// Push one frame. Returns whether it passed the quality gates —
    /// capture loops use this to pause the clock on bad footage.
    pub fn push(&mut self, f: &FrameFeatures) -> bool {
        if self.started_at.is_none() {
            self.begin();
        }
        if self.trace_enabled {
            let mut tf = f.clone();
            tf.eye_contour = Vec::new();
            self.trace_frames.push(tf);
        }
        if self.first_t.is_none() {
            self.first_t = Some(f.t);
        }
        self.last_t = Some(f.t);

        let v = self.quality.check(f);
        if self.trace_enabled {
            self.trace_diag.push(TraceDiag {
                ok: v.ok,
                reasons: v.reasons.iter().map(|r| r.as_str().to_string()).collect(),
                glare: v.glare,
                backlit: v.backlit,
                fps: v.fps,
            });
        }
        if f.face {
            self.face_frames += 1;
            if v.glare {
                self.glare_frames += 1;
            }
            if v.backlit {
                self.backlit_frames += 1;
            }
        }
        if !v.ok {
            self.jaw_since = None;
            return false;
        }
        self.detector.push(f);
        self.lumas.push(f.face_luma);
        self.squints.push((f.squint_l + f.squint_r) / 2.0);
        if f.iris_px > 0.0 {
            self.distances
                .push(estimate_distance_cm(f.iris_px, f.frame_w));
        }

        if f.jaw_open > 0.5 {
            match self.jaw_since {
                None => self.jaw_since = Some(f.t),
                Some(since) if f.t - since >= 1500.0 => {
                    self.yawn_count += 1;
                    self.jaw_since = None;
                }
                _ => {}
            }
        } else {
            self.jaw_since = None;
        }
        true
    }

    pub fn fps_mean(&self) -> f64 {
        let s = &self.quality.fps_samples;
        if s.is_empty() {
            0.0
        } else {
            s.iter().sum::<f64>() / s.len() as f64
        }
    }

    /// The last quality verdict (for live status lines), if any.
    pub fn last_verdict(&self) -> Option<&crate::quality::QualityVerdict> {
        self.quality.last.as_ref()
    }

    pub fn result(&mut self, source: Source) -> QuickCheckResult {
        self.detector.finish();
        let d = &self.detector;
        let events = &d.events;
        let complete: Vec<_> = events.iter().filter(|e| e.complete).collect();
        let incomplete: Vec<_> = events.iter().filter(|e| !e.complete).collect();
        let quality_min = d.quality_ms / 60000.0;
        let ibis = d.inter_blink_intervals();
        let duration_ms = match (self.first_t, self.last_t) {
            (Some(a), Some(b)) => b - a,
            _ => 0.0,
        };
        let quality_pct = if duration_ms > 0.0 {
            (d.quality_ms / duration_ms) * 100.0
        } else {
            0.0
        };
        let (lower, upper) = poisson_interval(events.len());
        let glare_pct = if self.face_frames > 0 {
            (self.glare_frames as f64 / self.face_frames as f64) * 100.0
        } else {
            0.0
        };
        let backlit_pct = if self.face_frames > 0 {
            (self.backlit_frames as f64 / self.face_frames as f64) * 100.0
        } else {
            0.0
        };
        let fps_mean = self.fps_mean();

        let core = Core {
            blink_rate: if quality_min > 0.0 {
                events.len() as f64 / quality_min
            } else {
                0.0
            },
            incomplete_ratio: if !events.is_empty() {
                incomplete.len() as f64 / events.len() as f64
            } else {
                0.0
            },
            mean_blink_ms: if events.is_empty() {
                0.0
            } else {
                events.iter().map(|e| e.duration_ms).sum::<f64>() / events.len() as f64
            },
            mean_reopen_frac: mean(
                &events
                    .iter()
                    .filter(|e| e.close_ms + e.reopen_ms > 0.0)
                    .map(|e| e.reopen_ms / (e.close_ms + e.reopen_ms))
                    .collect::<Vec<_>>(),
            ),
            perclos: d.perclos(),
            max_ibi_ms: ibis.iter().copied().fold(0.0, f64::max),
            distance_cm: median(&self.distances),
            luma: median(&self.lumas),
        };
        let blink_rate_low = if quality_min > 0.0 {
            lower / quality_min
        } else {
            0.0
        };
        let blink_rate_high = if quality_min > 0.0 {
            upper / quality_min
        } else {
            0.0
        };

        // distanceAvailable: only a video file lacks a live camera's iris
        // metric.
        let assessment = assess(&core, events.len(), source != Source::File);
        let conf = assess_confidence(&ConfidenceInput {
            quality_ms: d.quality_ms,
            quality_pct,
            fps_mean,
            glare_pct,
            backlit_pct,
            discard_pct: d.discard_pct(),
            candidate_count: d.candidate_count(),
        });

        QuickCheckResult {
            schema_version: 2,
            id: uuid::Uuid::new_v4().to_string(),
            started_at: self.started_at.clone().unwrap_or_else(iso_now),
            duration_ms,
            quality_ms: d.quality_ms,
            quality_pct,
            blink_rate: core.blink_rate,
            blink_rate_low,
            blink_rate_high,
            complete_blinks: complete.len(),
            incomplete_blinks: incomplete.len(),
            incomplete_ratio: core.incomplete_ratio,
            mean_blink_ms: core.mean_blink_ms,
            mean_reopen_frac: core.mean_reopen_frac,
            long_closures: events.iter().filter(|e| e.long_closure).count(),
            perclos: core.perclos,
            max_ibi_ms: core.max_ibi_ms,
            ibi_over10s: ibis.iter().filter(|&&g| g > config::IBI_WATCH_MS).count(),
            distance_cm: core.distance_cm,
            luma: core.luma,
            squint: mean(&self.squints),
            yawns: self.yawn_count,
            fps_mean,
            glare_pct,
            backlit_pct,
            gaze_down_discards: d.gaze_down_discards,
            asymmetric_discards: d.asymmetric_discards,
            confidence: conf.confidence,
            confidence_reasons: conf.reasons,
            tips: assessment.tips,
            statuses: assessment.statuses,
            source: Some(source),
            self_report: None,
            fatigue_score: None,
        }
    }
}

pub struct ConfidenceInput {
    pub quality_ms: f64,
    pub quality_pct: f64,
    pub fps_mean: f64,
    pub glare_pct: f64,
    pub backlit_pct: f64,
    pub discard_pct: f64,
    pub candidate_count: usize,
}

pub struct ConfidenceOut {
    pub confidence: Confidence,
    pub reasons: Vec<ConfidenceReason>,
}

pub fn assess_confidence(i: &ConfidenceInput) -> ConfidenceOut {
    let mut reasons: Vec<ConfidenceReason> = Vec::new();
    if i.quality_ms < config::CONF_HIGH_QUALITY_MS {
        reasons.push(ConfidenceReason {
            text: format!(
                "Only {:.0} s of usable footage ({:.0} s+ recommended)",
                (i.quality_ms / 1000.0).round(),
                (config::CONF_HIGH_QUALITY_MS / 1000.0).round()
            ),
            fix: "Keep your face in frame and well lit for the whole check.".to_string(),
        });
    }
    if i.quality_pct < config::CONF_HIGH_QUALITY_PCT {
        reasons.push(ConfidenceReason {
            text: format!(
                "{:.0}% of frames were usable ({:.0}%+ recommended)",
                i.quality_pct.round(),
                config::CONF_HIGH_QUALITY_PCT
            ),
            fix: "Hold still and face the camera so fewer frames are dropped.".to_string(),
        });
    }
    if i.fps_mean < config::CONF_HIGH_FPS {
        reasons.push(ConfidenceReason {
            text: format!(
                "Frame rate averaged {:.0} fps ({:.0}+ recommended)",
                i.fps_mean,
                config::CONF_HIGH_FPS
            ),
            fix: "Add light, or close other apps using the camera/CPU.".to_string(),
        });
    }
    if i.glare_pct > config::CONF_HIGH_GLARE_PCT {
        reasons.push(ConfidenceReason {
            text: format!(
                "Reflections on glasses in {:.0}% of frames",
                i.glare_pct.round()
            ),
            fix: "Tilt your glasses slightly or move the light source off to the side.".to_string(),
        });
    }
    if i.backlit_pct > config::CONF_HIGH_BACKLIT_PCT {
        reasons.push(ConfidenceReason {
            text: format!(
                "Strong backlight in {:.0}% of frames",
                i.backlit_pct.round()
            ),
            fix: "Face a window or lamp so the light falls on your face.".to_string(),
        });
    }
    let discard_abstain = i.candidate_count >= config::MAX_DISCARD_MIN_CANDIDATES
        && i.discard_pct > config::MAX_DISCARD_PCT;
    if discard_abstain {
        reasons.push(ConfidenceReason {
            text: format!(
                "{:.0}% of {} blink candidates were discarded (gaze-down or one-sided closures)",
                i.discard_pct.round(),
                i.candidate_count
            ),
            fix: "Face the camera squarely and keep both eyes in view, then try again.".to_string(),
        });
    } else if i.discard_pct > config::CONF_HIGH_DISCARD_PCT {
        reasons.push(ConfidenceReason {
            text: format!(
                "{:.0}% of blink candidates were discarded",
                i.discard_pct.round()
            ),
            fix: "Look straight at the screen and keep both eyes visible.".to_string(),
        });
    }
    let confidence = if reasons.is_empty() {
        Confidence::High
    } else if discard_abstain {
        Confidence::Low
    } else {
        let medium = i.quality_ms >= config::CONF_MED_QUALITY_MS
            && i.quality_pct >= config::CONF_MED_QUALITY_PCT
            && i.fps_mean >= config::CONF_MED_FPS;
        if medium {
            Confidence::Medium
        } else {
            Confidence::Low
        }
    };
    ConfidenceOut {
        confidence,
        reasons,
    }
}

pub fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut s = xs.to_vec();
    s.sort_by(f64::total_cmp);
    let mid = s.len() / 2;
    if s.len() % 2 == 1 {
        s[mid]
    } else {
        (s[mid - 1] + s[mid]) / 2.0
    }
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        0.0
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}
