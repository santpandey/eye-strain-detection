//! Central tuning knobs. Every numeric threshold in the analysis pipeline
//! lives here. All values are initial values — tune with the A5 accuracy eval.
//!
//! Keep in sync with src/lib/analysis/config.ts and cli/blinkwell/config.py —
//! this is a 1:1 port. The monitor* knobs moved out of config.ts when the
//! web monitor was cut; the CLI owns monitoring now, so they live here.

/// Quality gates (initial values, tune with A5 eval).
pub const HEAD_POSE_DEG: f64 = 20.0; // |yaw| or |pitch| beyond this → 'headPose'
pub const FACE_LUMA_MIN: f64 = 45.0; // face-region luma below this → 'dark'
pub const LOW_FPS_MIN: f64 = 15.0; // processed fps below this → 'lowFps'
pub const LOW_FPS_WINDOW_MS: f64 = 2000.0;
pub const LOW_FPS_MIN_FRAMES: usize = 10; // judge fps once this many frames are in the window…
pub const LOW_FPS_MIN_SPAN_MS: f64 = 1000.0; // …or once the window spans this long, whichever first
pub const MOTION_MAX_IOW_PER_SEC: f64 = 1.5; // nose speed in interocular-widths/s → 'motion'

/// Non-gating signals (initial values, tune with A5 eval).
pub const GLARE_FRAC: f64 = 0.03; // glare share above this → glare frame
pub const GLARE_LUMA_CUT: f64 = 245.0;
pub const BACKLIT_DELTA: f64 = 50.0; // frameLuma − faceLuma above this → backlit

/// Blink detector (initial values, tune with A5 eval).
pub const EAR_BASELINE_MS: f64 = 10_000.0;
pub const EAR_BASELINE_MIN_SAMPLES: usize = 15;
pub const EAR_OPEN_FALLBACK: f64 = 0.28;

/// Detector v2: prominence over a local rest level (initial values, tune with
/// A5 eval). Defaults = centre of the high plateau of `npm run eval:trace --
/// --grid` over the 3 traces of the 73 s phone clip (28 labels; one clip —
/// don't overfit).
pub const REST_WINDOW_MS: f64 = 3000.0; // rest = rolling percentile of c over this window
pub const REST_PERCENTILE: f64 = 30.0; // …at this percentile (0–100); frozen while an event is open
pub const PROM_START: f64 = 0.3; // open an event when c − rest exceeds this
pub const PROM_END: f64 = 0.08; // close it when c − rest falls below this
pub const VALLEY_DROP: f64 = 0.2; // split: c must fall ≥ this below the event peak…
pub const RISE_AGAIN: f64 = 0.2; // …then rise ≥ this above that valley → new event at the valley
pub const SETTLE_MS: f64 = 200.0; // end an event once c sits within settleBand this long after the peak…
pub const SETTLE_BAND: f64 = 0.05; // …(below peak − valleyDrop and the duration level); rest re-seeds there
pub const DURATION_FRAC: f64 = 0.5; // duration level = rest + durationFrac·(peak − rest)
pub const PEAK_COMPLETE: f64 = 0.8; // absolute peak c for a complete blink
pub const MAX_BLINK_MS: f64 = 3000.0;
pub const LONG_CLOSURE_MS: f64 = 500.0;
pub const EAR_DROP_FRAC: f64 = 0.6; // 60% EAR drop = fully closed
pub const PERCLOS_LEVEL: f64 = 0.8;
pub const DT_CAP_MS: f64 = 100.0;

/// Gaze-down discard, relative to the user's own rest level (initial values,
/// tune with A5 eval). Absolute thresholds don't work: resting lookDown varies
/// per user and lids dropping reads as gaze-down at blink onset.
pub const GAZE_REST_WINDOW_MS: f64 = 5000.0; // rolling median lookDown over non-event frames
pub const GAZE_POST_OFFSET_MS: f64 = 100.0; // post-event window starts this long after the event end…
pub const GAZE_POST_MS: f64 = 400.0; // …and spans this long; median lookDown over it vs rest
pub const GAZE_DOWN_RISE: f64 = 0.3; // discard when post-event lookDown exceeds rest by this
/// The next blink's lid drop also reads as lookDown, so when another event
/// opens within the post window (+this pad, since detect-start lags onset)
/// the check is skipped.
pub const GAZE_NEIGHBOR_PAD_MS: f64 = 150.0;
pub const ASYMMETRY_MAX: f64 = 0.4;

/// Abstain when this share of candidates is discarded (needs ≥ min candidates).
pub const MAX_DISCARD_PCT: f64 = 40.0;
pub const MAX_DISCARD_MIN_CANDIDATES: usize = 5;

/// Capture (initial values, tune with A5 eval).
pub const CAPTURE_MS: f64 = 90_000.0;
pub const ABORT_GAP_MS: f64 = 30_000.0;
pub const ALIGN_HOLD_MS: f64 = 1000.0;

/// File analysis adaptive playback (initial values, tune with A5 eval).
pub const FILE_TARGET_FPS: f64 = 30.0; // processed frames per media-second
pub const FILE_PLAYBACK_MIN: f64 = 0.1; // slowest playbackRate used for file analysis

/// Confidence tiers (initial values, tune with A5 eval).
pub const CONF_HIGH_QUALITY_MS: f64 = 80_000.0;
pub const CONF_HIGH_QUALITY_PCT: f64 = 80.0;
pub const CONF_HIGH_FPS: f64 = 24.0;
pub const CONF_HIGH_GLARE_PCT: f64 = 10.0;
pub const CONF_HIGH_BACKLIT_PCT: f64 = 20.0;
pub const CONF_HIGH_DISCARD_PCT: f64 = 15.0;
pub const CONF_MED_QUALITY_MS: f64 = 60_000.0;
pub const CONF_MED_QUALITY_PCT: f64 = 60.0;
pub const CONF_MED_FPS: f64 = 15.0;

/// Per-metric minimum event counts (initial values, tune with A5 eval).
pub const MIN_EVENTS_MEAN_BLINK: usize = 5;
pub const MIN_EVENTS_INCOMPLETE: usize = 8;

/// Personal baseline (initial values — no eval coverage yet).
pub const BASELINE_MIN_SESSIONS: u32 = 3; // contributing saved checks before baselineReady
pub const BASELINE_RESERVOIR: usize = 40; // per-metric reservoir cap (last N session values)

/// Composite fatigue score (initial values — no eval coverage yet).
pub const SCORE_MIN_EVENTS: usize = 5; // total blink events below this → score null
pub const SCORE_SATURATE_K: f64 = 2.0; // sub-score = r/(r+K) where r = value/reference
pub const SCORE_WEIGHT_PERCLOS: f64 = 0.35;
pub const SCORE_WEIGHT_MEAN_BLINK_MS: f64 = 0.25;
pub const SCORE_WEIGHT_MEAN_REOPEN_FRAC: f64 = 0.2;
pub const SCORE_WEIGHT_INCOMPLETE_RATIO: f64 = 0.2;
pub const SCORE_WATCH: f64 = 40.0; // score below this → 'good' chip
pub const SCORE_HIGH: f64 = 70.0; // score at/above this → 'high' chip

/// Metric status thresholds (initial values, tune with A5 eval).
pub const BLINK_RATE_HIGH_LOW: f64 = 8.0;
pub const BLINK_RATE_WATCH_LOW: f64 = 12.0;
pub const BLINK_RATE_WATCH_HIGH: f64 = 22.0;
pub const BLINK_RATE_HIGH_HIGH: f64 = 30.0;
pub const INCOMPLETE_WATCH: f64 = 0.3;
pub const INCOMPLETE_HIGH: f64 = 0.5;
pub const MEAN_BLINK_WATCH_MS: f64 = 300.0;
pub const MEAN_BLINK_HIGH_MS: f64 = 400.0;
/// Share of closed time spent reopening (Schleicher 2008: slow lid reopening
/// is a top-3 drowsiness indicator). Initial values, tune with labelled data.
pub const REOPEN_FRAC_WATCH: f64 = 0.75;
pub const REOPEN_FRAC_HIGH: f64 = 0.85;
pub const PERCLOS_WATCH: f64 = 0.08;
pub const PERCLOS_HIGH: f64 = 0.15;
pub const IBI_WATCH_MS: f64 = 10_000.0;
pub const IBI_HIGH_MS: f64 = 20_000.0;
pub const DISTANCE_WATCH_CM: f64 = 50.0;
pub const DISTANCE_HIGH_CM: f64 = 40.0;
pub const LUMA_WATCH: f64 = 60.0;

/// Background monitor (the CLI owns monitoring; these were removed from
/// config.ts when the in-app monitor was cut).
pub const MONITOR_INTERVAL_MS: f64 = 900_000.0; // camera-on window every ~15 min
pub const MONITOR_WINDOW_MS: f64 = 60_000.0; // each check window runs ~1 min
pub const MONITOR_BREAK_EVERY_MS: f64 = 1_200_000.0; // 20-20-20 break nudge every ~20 min
pub const MONITOR_REMINDER_SNOOZE_MS: f64 = 300_000.0; // a dismissed reminder stays quiet ~5 min
pub const MONITOR_STARTUP_DELAY_MS: f64 = 3_000.0; // first window this long after monitor start

/// Eval (initial values, tune with A5 eval).
pub const MATCH_TOL_MS: f64 = 150.0;
pub const EVAL_TRACE_TOL_MS: f64 = 300.0; // default tol of scripts/eval-trace.ts (labels lag ~220 ms)
pub const DEFAULT_MIN_F1: f64 = 0.85;
