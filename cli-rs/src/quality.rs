//! Stateful quality gate — 1:1 port of src/lib/analysis/quality.ts.

use crate::config;
use crate::features::FrameFeatures;
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    NoFace,
    HeadPose,
    Dark,
    LowFps,
    Motion,
}

impl Reason {
    /// The TS string form ('noFace', 'headPose', …).
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NoFace => "noFace",
            Reason::HeadPose => "headPose",
            Reason::Dark => "dark",
            Reason::LowFps => "lowFps",
            Reason::Motion => "motion",
        }
    }
}

#[derive(Debug, Clone)]
pub struct QualityVerdict {
    pub ok: bool,
    pub reasons: Vec<Reason>,
    /// Non-gating signals, for guidance + confidence.
    pub glare: bool,
    pub backlit: bool,
    pub fps: f64,
}

/// Stateful quality gate. Tracks the processed-frame timestamps for rolling
/// fps (on the frame's own `t` timeline, so file sources work) and the
/// previous nose position for motion.
#[derive(Debug, Default)]
pub struct QualityCtx {
    ts: VecDeque<f64>,
    prev_nose: Option<[f64; 2]>,
    prev_t: Option<f64>,
    first_t: Option<f64>,
    pub fps_samples: Vec<f64>,
    /// Verdict of the most recent check.
    pub last: Option<QualityVerdict>,
}

impl QualityCtx {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn check(&mut self, f: &FrameFeatures) -> QualityVerdict {
        // Rolling processed fps over the last window. Judged once the window
        // holds LOW_FPS_MIN_FRAMES frames OR covers LOW_FPS_MIN_SPAN_MS,
        // whichever comes first — so very slow streams (a few fps) are still
        // caught.
        if self.first_t.is_none() {
            self.first_t = Some(f.t);
        }
        let first_t = self.first_t.unwrap_or(f.t);
        self.ts.push_back(f.t);
        let cutoff = f.t - config::LOW_FPS_WINDOW_MS;
        while self.ts.front().is_some_and(|&t| t < cutoff) {
            self.ts.pop_front();
        }
        let n = self.ts.len();
        let span_ms = if n > 1 {
            self.ts[n - 1] - self.ts[0]
        } else {
            0.0
        };
        // Time covered by the window (≥ frame span; also counts a lone frame).
        let window_ms = config::LOW_FPS_WINDOW_MS.min(f.t - first_t);
        let judged = n >= config::LOW_FPS_MIN_FRAMES
            || span_ms.max(window_ms) >= config::LOW_FPS_MIN_SPAN_MS;
        let fps = if n >= 2 && span_ms > 0.0 {
            ((n - 1) as f64 * 1000.0) / span_ms
        } else if judged && window_ms > 0.0 {
            (n as f64 * 1000.0) / window_ms
        } else {
            0.0
        };
        if judged {
            self.fps_samples.push(fps);
        }

        let mut reasons: Vec<Reason> = Vec::new();
        if !f.face {
            reasons.push(Reason::NoFace);
        } else {
            if f.yaw.abs() > config::HEAD_POSE_DEG || f.pitch.abs() > config::HEAD_POSE_DEG {
                reasons.push(Reason::HeadPose);
            }
            if f.face_luma < config::FACE_LUMA_MIN {
                reasons.push(Reason::Dark);
            }
            // Motion: nose speed in interocular-widths per second.
            if let (Some(prev_nose), Some(prev_t)) = (self.prev_nose, self.prev_t) {
                if f.interocular_px > 0.0 {
                    let dt = (f.t - prev_t) / 1000.0;
                    if dt > 0.0 {
                        let iow = f.interocular_px / f.frame_w;
                        let speed =
                            (f.nose[0] - prev_nose[0]).hypot(f.nose[1] - prev_nose[1]) / iow / dt;
                        if speed > config::MOTION_MAX_IOW_PER_SEC {
                            reasons.push(Reason::Motion);
                        }
                    }
                }
            }
            self.prev_nose = Some(f.nose);
            self.prev_t = Some(f.t);
        }
        if judged && fps < config::LOW_FPS_MIN {
            reasons.push(Reason::LowFps);
        }

        let verdict = QualityVerdict {
            ok: reasons.is_empty(),
            reasons,
            glare: f.glare[0].max(f.glare[1]) > config::GLARE_FRAC,
            backlit: f.face && f.frame_luma - f.face_luma > config::BACKLIT_DELTA,
            fps,
        };
        self.last = Some(verdict.clone());
        verdict
    }
}

/// Guidance lines in priority order for the align phase / capture pause.
pub fn guidance_for(v: Option<&QualityVerdict>, fallback: &str) -> String {
    let Some(v) = v else {
        return "Looking for your face…".to_string();
    };
    if v.reasons.contains(&Reason::NoFace) {
        return "Looking for your face…".to_string();
    }
    if v.reasons.contains(&Reason::HeadPose) {
        return "Face the screen".to_string();
    }
    if v.reasons.contains(&Reason::Dark) {
        return "More light on your face needed".to_string();
    }
    if v.backlit {
        return "Light is behind you — face a window or lamp".to_string();
    }
    if v.reasons.contains(&Reason::LowFps) {
        return "Camera is too slow — add light or close other apps".to_string();
    }
    if v.reasons.contains(&Reason::Motion) {
        return "Hold still".to_string();
    }
    fallback.to_string()
}
