//! blinkwell — on-device eye-fatigue monitor: the web app's analysis pipeline as
//! a local process.
//!
//! Commands:
//!   check    live quick check (camera on for --seconds, then the result card)
//!   monitor  periodic ~60 s camera windows every ~15 min; camera LED is ON
//!            only during a window — between windows the device is released
//!   replay   run a video file through the same pipeline (source 'file')
//!   trace    replay a recorded trace JSON through the Rust pipeline and
//!            score it against labels (parity tool for scripts/eval-trace.ts)

use anyhow::{Context, Result};
use blinkwell::capture::{self, FrameOut, LandmarkerEngine};
use blinkwell::config;
use blinkwell::eval::match_blinks;
use blinkwell::exercises::exercise;
use blinkwell::features::FrameFeatures;
use blinkwell::quality::guidance_for;
use blinkwell::report;
use blinkwell::rules::{evaluate_reminders, MonitorRuleState};
use blinkwell::score::{score_and_learn, FatigueScoreOut};
use blinkwell::session::{Confidence, QuickCheckAggregator, QuickCheckResult, Source};
use blinkwell::storage;
use blinkwell::thresholds::{Status, DISCLAIMER};
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Parser)]
#[command(
    name = "blinkwell",
    version,
    about = "On-device eye-fatigue monitor — the web app's analysis pipeline as a local process."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// List camera devices the OS reports (for picking --camera).
    Cameras,
    /// Show recent checks + a score sparkline from ~/.eyefd/history.jsonl.
    History {
        /// How many recent sessions to show.
        #[arg(long, default_value_t = 20)]
        n: usize,
    },
    /// Generate + open an HTML dashboard of your history (charts, filters).
    Report,
    /// Live quick check (camera on for --seconds).
    Check {
        /// Seconds of footage to capture.
        #[arg(long, default_value_t = config::CAPTURE_MS / 1000.0)]
        seconds: f64,
        /// Camera index.
        #[arg(long, default_value_t = 0)]
        camera: u32,
        /// Seconds to spend on face alignment first (0 = skip the guide).
        #[arg(long, default_value_t = 30.0)]
        align_timeout: f64,
        /// Machine-readable output lines.
        #[arg(long)]
        json: bool,
        /// Override face_landmarker.task path.
        #[arg(long)]
        model: Option<PathBuf>,
    },
    /// Periodic camera windows; LED off between windows. Ctrl+C to stop.
    Monitor {
        /// Minutes between window starts.
        #[arg(long, default_value_t = config::MONITOR_INTERVAL_MS / 60_000.0)]
        interval_min: f64,
        /// Seconds of footage per window.
        #[arg(long, default_value_t = config::MONITOR_WINDOW_MS / 1000.0)]
        window_s: f64,
        /// Minutes between 20-20-20 break reminders.
        #[arg(long, default_value_t = config::MONITOR_BREAK_EVERY_MS / 60_000.0)]
        break_every_min: f64,
        /// Camera index.
        #[arg(long, default_value_t = 0)]
        camera: u32,
        /// Machine-readable output lines.
        #[arg(long)]
        json: bool,
        /// Override face_landmarker.task path.
        #[arg(long)]
        model: Option<PathBuf>,
    },
    /// Run a video file through the same pipeline (needs ffmpeg).
    Replay {
        /// Video file path.
        video: PathBuf,
        /// Machine-readable output lines.
        #[arg(long)]
        json: bool,
        /// Override face_landmarker.task path.
        #[arg(long)]
        model: Option<PathBuf>,
        /// ffmpeg executable path (default: found on PATH).
        #[arg(long)]
        ffmpeg: Option<PathBuf>,
    },
    /// Replay a recorded trace JSON (+ optional labels scoring).
    Trace {
        /// Trace JSON file(s) — {schema,frames:[...]} or {trace:{frames:[...]}}.
        traces: Vec<PathBuf>,
        /// Labels JSON (.labels.json) for TP/FP/FN scoring.
        #[arg(long)]
        labels: Option<PathBuf>,
        /// Match tolerance in ms (default: eval-trace.ts default, 300).
        #[arg(long, default_value_t = config::EVAL_TRACE_TOL_MS)]
        tol: f64,
        /// Machine-readable output lines.
        #[arg(long)]
        json: bool,
        /// Unused for trace — accepted for a uniform flag set.
        #[arg(long, hide = true)]
        model: Option<PathBuf>,
    },
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn model_path(model: &Option<PathBuf>) -> PathBuf {
    model.clone().unwrap_or_else(capture::default_model_path)
}

// ------------------------------------------------------------ result card --

fn fmt_metric(name: &str, value: &str, status: Status) -> String {
    let tag = match status {
        Status::Good => " ok ",
        Status::Watch => "WARN",
        Status::High => "HIGH",
        Status::Na => "  — ",
    };
    format!("  [{tag}] {name:<28} {value}")
}

fn print_result_card(r: &QuickCheckResult, score_out: Option<&FatigueScoreOut>, saved: bool) {
    let st = &r.statuses;
    let bar = "─".repeat(52);
    println!("{bar}");
    println!("  {}", blinkwell::thresholds::overall_verdict(st));
    if let Some(out) = score_out {
        if let Some(score) = out.score {
            let anchor = if out.baseline_ready {
                "personal baseline"
            } else {
                "population estimate"
            };
            println!(
                "  Fatigue score: {:.0}/100  ({anchor}; higher = more tired)",
                score
            );
        }
    } else if let Some(fs) = r.fatigue_score {
        println!("  Fatigue score: {:.0}/100  (higher = more tired)", fs);
    }
    println!("{bar}");
    println!(
        "{}",
        fmt_metric(
            &format!(
                "blink rate ({:.0}–{:.0})",
                r.blink_rate_low, r.blink_rate_high
            ),
            &format!("{:.1}/min", r.blink_rate),
            st.blink_rate,
        )
    );
    println!(
        "        {:<28} {} ({})",
        "blinks (complete)",
        r.complete_blinks + r.incomplete_blinks,
        r.complete_blinks
    );
    println!(
        "{}",
        fmt_metric(
            "partial-blink share",
            &format!("{:.2}", r.incomplete_ratio),
            st.incomplete_ratio,
        )
    );
    println!(
        "{}",
        fmt_metric(
            "mean blink duration",
            &format!("{:.0} ms", r.mean_blink_ms),
            st.mean_blink_ms,
        )
    );
    println!(
        "{}",
        fmt_metric(
            "lid reopen share",
            &format!("{:.2}", r.mean_reopen_frac),
            st.reopen_frac,
        )
    );
    println!(
        "{}",
        fmt_metric(
            "PERCLOS (eyes closed)",
            &format!("{:.1}%", r.perclos * 100.0),
            st.perclos,
        )
    );
    println!(
        "{}",
        fmt_metric(
            "longest blink-free gap",
            &format!("{:.0} s", r.max_ibi_ms / 1000.0),
            st.max_ibi_ms,
        )
    );
    let dist = if st.distance_cm != Status::Na {
        format!("{:.0} cm", r.distance_cm)
    } else {
        "n/a (file)".to_string()
    };
    println!("{}", fmt_metric("screen distance", &dist, st.distance_cm));
    println!(
        "{}",
        fmt_metric("face brightness", &format!("{:.0}", r.luma), st.luma)
    );
    println!("{bar}");
    let mut extra: Vec<String> = Vec::new();
    if r.long_closures > 0 {
        extra.push(format!("{} long closure(s)", r.long_closures));
    }
    if r.yawns > 0 {
        extra.push(format!("{} yawn(s)", r.yawns));
    }
    if r.gaze_down_discards > 0 || r.asymmetric_discards > 0 {
        extra.push(format!(
            "discards: {} gaze-down, {} one-sided",
            r.gaze_down_discards, r.asymmetric_discards
        ));
    }
    if !extra.is_empty() {
        println!("  {}", extra.join(" · "));
    }
    println!(
        "  confidence: {}  ({:.0} s usable of {:.0} s, fps avg {:.1}, glare {:.0}%, backlit {:.0}%)",
        r.confidence.as_str(),
        r.quality_ms / 1000.0,
        r.duration_ms / 1000.0,
        r.fps_mean,
        r.glare_pct,
        r.backlit_pct
    );
    for reason in &r.confidence_reasons {
        println!("    - {} → {}", reason.text, reason.fix);
    }
    if !saved {
        println!("  not saved — confidence too low to trust (the app 'abstains' the same way)");
    }
    for tip in &r.tips {
        println!("  tip: {tip}");
    }
    println!("  {DISCLAIMER}");
    println!("{bar}");
}

// --------------------------------------------------------- capture plumbing --

/// Feed a frame source into a fresh aggregator; progress lines unless --json.
fn run_capture<F>(
    json_mode: bool,
    status_prefix: &str,
    mut run_source: F,
) -> Result<(QuickCheckResult, QuickCheckAggregator)>
where
    F: FnMut(&mut dyn FnMut(&FrameOut) -> bool) -> Result<()>,
{
    let mut agg = QuickCheckAggregator::new();
    let mut last_status = -f64::INFINITY;
    {
        let agg = &mut agg;
        run_source(&mut |out: &FrameOut| -> bool {
            let f = &out.features;
            if !json_mode && (out.elapsed_ms - last_status >= 5000.0 || out.n == 1) {
                last_status = out.elapsed_ms;
                let note = match agg.last_verdict() {
                    Some(v) => guidance_for(Some(v), "tracking"),
                    None => "…".to_string(),
                };
                print!(
                    "\r{status_prefix}{:6.1}s  frames {:<5} {:<58}",
                    out.elapsed_ms / 1000.0,
                    out.n,
                    note
                );
                let _ = std::io::stdout().flush();
            }
            agg.push(f)
        })?;
    }
    if !json_mode {
        println!();
    }
    let r = agg.result(Source::Camera);
    Ok((r, agg))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonResult<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    saved: bool,
    result: &'a QuickCheckResult,
}

/// Shared check/replay tail: abstain on low confidence, else score vs
/// baseline → learn → save (same order as the app).
fn finish_result(mut r: QuickCheckResult, json_mode: bool) -> QuickCheckResult {
    if r.confidence == Confidence::Low {
        if json_mode {
            println!(
                "{}",
                serde_json::to_string(&JsonResult {
                    kind: "result",
                    saved: false,
                    result: &r,
                })
                .unwrap_or_default()
            );
        } else {
            print_result_card(&r, None, false);
        }
        return r;
    }
    let view = score_and_learn(&mut r);
    let saved = storage::save_session(&r).is_ok();
    if json_mode {
        println!(
            "{}",
            serde_json::to_string(&JsonResult {
                kind: "result",
                saved,
                result: &r,
            })
            .unwrap_or_default()
        );
    } else {
        print_result_card(&r, Some(&view.out), saved);
    }
    r
}

// ------------------------------------------------------------------ check --

fn cmd_check(
    seconds: f64,
    camera: u32,
    align_timeout: f64,
    json: bool,
    model: &Option<PathBuf>,
) -> Result<()> {
    let model_path = model_path(model);
    let mut engine = LandmarkerEngine::new(&model_path)?;
    if !json {
        println!(
            "blinkwell check — camera on for {seconds:.0} s (webcam light on = honest signal)"
        );
    }
    let cancel = cancel_flag();
    let (r, _agg) = run_capture(json, "check  ", |on_frame| {
        capture::run_camera_aligned(
            &mut engine,
            camera,
            seconds * 1000.0,
            align_timeout * 1000.0,
            !json,
            Some(cancel.clone()),
            on_frame,
        )
    })?;
    drop(engine);
    finish_result(r, json);
    Ok(())
}

// ----------------------------------------------------------------- replay --

fn cmd_replay(
    video: &Path,
    json: bool,
    model: &Option<PathBuf>,
    ffmpeg: &Option<PathBuf>,
) -> Result<()> {
    let ffmpeg = capture::find_ffmpeg(ffmpeg.as_deref()).context(
        "ffmpeg not found — `blinkwell replay` decodes video through `ffmpeg -f rawvideo`.\n\
         Install ffmpeg (on PATH) or pass --ffmpeg <path>.",
    )?;
    let model_path = model_path(model);
    let mut engine = LandmarkerEngine::new(&model_path)?;
    if !json {
        println!(
            "blinkwell replay — {} (file source: distance n/a)",
            video.display()
        );
    }
    let cancel = cancel_flag();
    let (r, _agg) = run_capture(json, "replay ", |on_frame| {
        capture::run_video_file(&mut engine, video, &ffmpeg, Some(cancel.clone()), on_frame)
    })?;
    drop(engine);
    finish_result(r, json);
    Ok(())
}

// ---------------------------------------------------------------- monitor --

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonReminder<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(flatten)]
    reminder: &'a blinkwell::rules::Reminder,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonWindow<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    window: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropped: Option<bool>,
    result: &'a QuickCheckResult,
}

fn cmd_monitor(
    interval_min: f64,
    window_s: f64,
    break_every_min: f64,
    camera: u32,
    json: bool,
    model: &Option<PathBuf>,
) -> Result<()> {
    let interval_ms = interval_min * 60_000.0;
    let window_ms = window_s * 1000.0;
    let break_every_ms = break_every_min * 60_000.0;
    let snooze_ms = config::MONITOR_REMINDER_SNOOZE_MS;

    let model_path = model_path(model);
    let mut engine = LandmarkerEngine::new(&model_path)?;
    let cancel = cancel_flag();

    let monitor_on_since = now_ms();
    let mut next_window_at = monitor_on_since + config::MONITOR_STARTUP_DELAY_MS;
    let last_break_at: Option<f64> = None;
    let mut last_window_result: Option<QuickCheckResult> = None;
    let mut windows_done: u32 = 0;
    let mut snoozed_until: HashMap<String, f64> = HashMap::new();
    let mut last_countdown = -f64::INFINITY;

    if !json {
        println!(
            "blinkwell monitor — {window_s:.0} s camera window every {interval_min:.0} min \
             (break nudge every {break_every_min:.0} min). Ctrl+C to stop."
        );
        println!("  camera LED is ON only while a window runs — that's the honest signal.");
    }

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let now = now_ms();
        if now >= next_window_at {
            windows_done += 1;
            let win_n = windows_done;
            if !json {
                println!(
                    "[window {win_n} @ {}] capturing {window_s:.0}s…",
                    chrono::Local::now().format("%H:%M:%S")
                );
            }
            let mut agg = QuickCheckAggregator::new();
            let cap = capture::run_camera(
                &mut engine,
                camera,
                window_ms,
                Some(cancel.clone()),
                &mut |out: &FrameOut| agg.push(&out.features),
            );
            if let Err(e) = cap {
                eprintln!("  camera error: {e:#}");
                next_window_at = now_ms() + interval_ms;
                continue;
            }
            let mut r = agg.result(Source::Monitor);
            last_window_result = None;
            if r.confidence != Confidence::Low {
                // Score vs pre-update baseline → learn → save (app order).
                score_and_learn(&mut r);
                let _ = storage::save_session(&r);
                if json {
                    println!(
                        "{}",
                        serde_json::to_string(&JsonWindow {
                            kind: "window",
                            window: win_n,
                            dropped: None,
                            result: &r,
                        })
                        .unwrap_or_default()
                    );
                } else {
                    print_result_card(&r, None, true);
                }
                last_window_result = Some(r);
            } else if json {
                println!(
                    "{}",
                    serde_json::to_string(&JsonWindow {
                        kind: "window",
                        window: win_n,
                        dropped: Some(true),
                        result: &r,
                    })
                    .unwrap_or_default()
                );
            } else {
                println!("  window {win_n}: low confidence — dropped (not saved)");
            }
            next_window_at = now_ms() + interval_ms;
        }

        // Refresh reminders.
        let state = MonitorRuleState {
            now,
            monitor_on_since,
            last_break_at,
            last_window_result: last_window_result.as_ref(),
            window_count: windows_done,
            break_every_ms: Some(break_every_ms),
        };
        for c in evaluate_reminders(&state) {
            // CLI has no dismiss button: printing a reminder counts as a
            // dismissal, so the kind stays quiet for the snooze interval.
            if snoozed_until.get(&c.kind).copied().unwrap_or(0.0) > now {
                continue;
            }
            snoozed_until.insert(c.kind.clone(), now + snooze_ms);
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&JsonReminder {
                        kind: "reminder",
                        reminder: &c,
                    })
                    .unwrap_or_default()
                );
            } else {
                println!(
                    "\n[{}] {}",
                    chrono::Local::now().format("%H:%M:%S"),
                    c.title
                );
                println!("  {}", c.body);
                if let Some(ex_id) = &c.exercise {
                    if let Some(e) = exercise(ex_id) {
                        println!("  exercise ({} s): {}", e.seconds, e.steps.join(" "));
                    }
                }
            }
            blinkwell::notify::send_notification(&c.title, &c.body);
        }

        // Between-window countdown line every ~30 s.
        if !json && next_window_at > now && now - last_countdown >= 30_000.0 {
            last_countdown = now;
            let left_s = ((next_window_at - now) / 1000.0).round() as u64;
            println!(
                "  next check in {}m {:02}s (camera off)",
                left_s / 60,
                left_s % 60
            );
        }

        // ~1 s scheduler tick; also caps Ctrl+C latency.
        let sleep_s = (next_window_at - now_ms()).clamp(0.05, 1.0);
        std::thread::sleep(Duration::from_secs_f64(sleep_s));
    }

    drop(engine);
    if !json {
        println!("\nmonitor stopped after {windows_done} window(s).");
    }
    Ok(())
}

// ------------------------------------------------------------------ trace --

fn load_trace_frames(path: &Path) -> Result<Vec<FrameFeatures>> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let j: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    let frames_v = j
        .get("trace")
        .and_then(|t| t.get("frames"))
        .or_else(|| j.get("frames"))
        .and_then(|v| v.as_array())
        .with_context(|| format!("{}: no frames / trace.frames array", path.display()))?;
    let mut out = Vec::with_capacity(frames_v.len());
    for v in frames_v {
        out.push(
            serde_json::from_value(v.clone())
                .with_context(|| format!("{}: bad frame object", path.display()))?,
        );
    }
    Ok(out)
}

fn load_labels(path: &Path) -> Result<Vec<f64>> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let j: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    let arr = j
        .get("blinks")
        .and_then(|v| v.as_array())
        .with_context(|| format!("{}: no blinks array", path.display()))?;
    Ok(arr
        .iter()
        .filter_map(|b| b.get("t").and_then(|t| t.as_f64()))
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonTraceOut<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    trace: String,
    events: &'a [blinkwell::blink::BlinkEvent],
    quality_ms: f64,
    gaze_down_discards: usize,
    asymmetric_discards: usize,
    result: &'a QuickCheckResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    match_: Option<serde_json::Value>,
}

fn cmd_trace(traces: &[PathBuf], labels: &Option<PathBuf>, tol: f64, json: bool) -> Result<()> {
    let labels = match labels {
        Some(p) => Some(load_labels(p)?),
        None => None,
    };
    for trace_path in traces {
        let frames = load_trace_frames(trace_path)?;
        let mut agg = QuickCheckAggregator::new();
        for f in &frames {
            agg.push(f);
        }
        let r = agg.result(Source::File);
        let det = &agg.detector;
        let name = trace_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| trace_path.display().to_string());

        let m = labels
            .as_ref()
            .map(|ls| match_blinks(&det.events, ls, det.quality_ms / 60000.0, Some(tol)));

        if json {
            let match_json = m.as_ref().map(|m| {
                serde_json::json!({
                    "tp": m.tp, "fp": m.fp, "fn": m.fn_,
                    "precision": m.precision, "recall": m.recall, "f1": m.f1,
                    "rateErrorPerMin": m.rate_error_per_min,
                    "detectedCount": m.detected_count, "trueCount": m.true_count,
                })
            });
            println!(
                "{}",
                serde_json::to_string(&JsonTraceOut {
                    kind: "trace",
                    trace: name.clone(),
                    events: &det.events,
                    quality_ms: det.quality_ms,
                    gaze_down_discards: det.gaze_down_discards,
                    asymmetric_discards: det.asymmetric_discards,
                    result: &r,
                    match_: match_json,
                })
                .unwrap_or_default()
            );
            continue;
        }

        println!(
            "\n=== {name}  ({} events, quality {:.2} s, discards g{}/a{})",
            det.events.len(),
            det.quality_ms / 1000.0,
            det.gaze_down_discards,
            det.asymmetric_discards
        );
        println!(" start    end   peak  rest  closedMs  kind");
        for e in &det.events {
            let kind = if e.complete && e.long_closure {
                "complete LONG"
            } else if e.complete {
                "complete"
            } else {
                "incomplete"
            };
            // .round() == JS toFixed(0) (half away from zero); {:.0} would be
            // round-half-to-even and disagree with eval-trace.ts on .5 values.
            println!(
                "{:7.0} {:7.0}  {:.2}  {:.2}  {:7.0}  {}",
                e.start.round(),
                e.end.round(),
                e.peak,
                e.rest,
                e.closed_ms.round(),
                kind
            );
        }
        if let Some(m) = &m {
            println!(
                "TP {}  FP {}  FN {}  P {:.3}  R {:.3}  F1 {:.3}   (tol {:.0} ms)",
                m.tp, m.fp, m.fn_, m.precision, m.recall, m.f1, tol
            );
            for lm in &m.label_matches {
                if lm.event.is_none() {
                    println!("  MISS label {:.0}", lm.t.round());
                }
            }
            for e in &m.unmatched_events {
                println!(
                    "  FP event {:.0}–{:.0} peak {:.2}",
                    e.start.round(),
                    e.end.round(),
                    e.peak
                );
            }
        }
        print_result_card(&r, None, true);
    }
    Ok(())
}

// ------------------------------------------------------------------- main --

fn cancel_flag() -> Arc<AtomicBool> {
    static FLAG: std::sync::OnceLock<Arc<AtomicBool>> = std::sync::OnceLock::new();
    FLAG.get_or_init(|| {
        let f = Arc::new(AtomicBool::new(false));
        let f2 = f.clone();
        let _ = ctrlc::set_handler(move || {
            f2.store(true, Ordering::SeqCst);
        });
        f
    })
    .clone()
}

fn cmd_history(n: usize) -> Result<()> {
    let mut sessions = storage::list_sessions();
    if sessions.is_empty() {
        println!("no saved checks yet — run `blinkwell check`");
        return Ok(());
    }
    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let recent: Vec<_> = sessions.iter().rev().take(n).collect();
    println!("recent checks ({} saved):", sessions.len());
    for s in recent.iter().rev() {
        let score = s
            .fatigue_score
            .map(|x| format!("{x:.0}"))
            .unwrap_or_else(|| "—".into());
        println!(
            "  {}  score {:>3}  blinks {:>4.1}/min  partial {:>3.0}%  {:?}",
            s.started_at
                .get(..16)
                .unwrap_or(&s.started_at)
                .replace('T', " "),
            score,
            s.blink_rate,
            s.incomplete_ratio * 100.0,
            s.confidence
        );
    }
    const SPARK: &[char] = &['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let scores: Vec<f64> = recent
        .iter()
        .rev()
        .filter_map(|s| s.fatigue_score)
        .collect();
    if scores.len() >= 2 {
        let line: String = scores
            .iter()
            .map(|x| SPARK[((x / 100.0).clamp(0.0, 1.0) * 7.0).round() as usize])
            .collect();
        println!("  fatigue trend (old→new): {line}");
    }
    Ok(())
}

fn main() {
    let cli = Cli::parse();
    let result = match &cli.cmd {
        // Bare `blinkwell`: yes/no entry point — no flags to learn.
        None => {
            print!("blinkwell — start monitoring now? (60 s camera every 15 min) [Y/n] ");
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let mut s = String::new();
            let _ = std::io::stdin().read_line(&mut s);
            let yes = s.trim().is_empty() || s.trim().eq_ignore_ascii_case("y");
            if yes {
                cmd_monitor(
                    config::MONITOR_INTERVAL_MS / 60_000.0,
                    config::MONITOR_WINDOW_MS / 1000.0,
                    config::MONITOR_BREAK_EVERY_MS / 60_000.0,
                    0,
                    false,
                    &None,
                )
            } else {
                println!("nothing started — try `blinkwell check` for a one-off, `blinkwell --help` for all commands");
                Ok(())
            }
        }
        Some(Cmd::History { n }) => cmd_history(*n),
        Some(Cmd::Report) => report::build_report().map(|path| {
            println!("blinkwell: report written to {}", path.display());
            report::open_report(&path);
        }),
        Some(Cmd::Cameras) => {
            let cams = capture::list_cameras();
            if cams.is_empty() {
                println!(
                    "blinkwell: no cameras detected by Windows (check Device Manager → Cameras)"
                );
            } else {
                for c in &cams {
                    println!("{c}");
                }
            }
            Ok(())
        }
        Some(Cmd::Check {
            seconds,
            camera,
            align_timeout,
            json,
            model,
        }) => cmd_check(*seconds, *camera, *align_timeout, *json, model),
        Some(Cmd::Monitor {
            interval_min,
            window_s,
            break_every_min,
            camera,
            json,
            model,
        }) => cmd_monitor(
            *interval_min,
            *window_s,
            *break_every_min,
            *camera,
            *json,
            model,
        ),
        Some(Cmd::Replay {
            video,
            json,
            model,
            ffmpeg,
        }) => cmd_replay(video, *json, model, ffmpeg),
        Some(Cmd::Trace {
            traces,
            labels,
            tol,
            json,
            model: _,
        }) => cmd_trace(traces, labels, *tol, *json),
    };
    if cancel_flag().load(Ordering::Relaxed) {
        eprintln!("\ninterrupted");
        std::process::exit(130);
    }
    match result {
        Ok(()) => {}
        Err(e) => {
            eprintln!("blinkwell: {e:#}");
            std::process::exit(1);
        }
    }
}
