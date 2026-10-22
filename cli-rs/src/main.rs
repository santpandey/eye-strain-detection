//! blinkwell — on-device eye-fatigue monitor: the web app's analysis pipeline as
//! a local process.
//!
//! Commands:
//!   check    live quick check (camera on for --seconds, then the result card)
//!   monitor  periodic ~60 s camera windows every ~10 min; camera LED is ON
//!            only during a window — between windows the device is released
//!   replay   run a video file through the same pipeline (source 'file')
//!   update   download the latest release and replace this binary in place
//!   trace    replay a recorded trace JSON through the Rust pipeline and
//!            score it against labels (parity tool for scripts/eval-trace.ts)

use anyhow::{bail, Context, Result};
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
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
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
    /// Terminal dashboard of saved checks: stats, metric bars, filters.
    /// Same data as `report` — no browser needed.
    History {
        /// How many recent groups/sessions to show.
        #[arg(long, default_value_t = 20)]
        n: usize,
        /// Only sessions from the last N days (0 = all).
        #[arg(long, default_value_t = 0)]
        days: u32,
        /// Group bars by: session | halfday | day.
        #[arg(long, default_value = "session")]
        group: String,
        /// Metric to chart: score | blinks | partial | perclos | blinkms |
        /// reopen | dist | usable.
        #[arg(long, default_value = "score")]
        metric: String,
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
        #[arg(long, default_value_t = 20.0)]
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
    /// Internal: capture a single monitor window, emit JSON lines on stdout.
    /// Spawned by `monitor` so a crash in native code kills only the window.
    #[command(name = "__window", hide = true)]
    Window {
        /// Seconds of usable footage to capture.
        #[arg(long)]
        window_s: f64,
        /// Camera index.
        #[arg(long, default_value_t = 0)]
        camera: u32,
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
    /// Download the latest release and replace this binary in place.
    Update {
        /// Machine-readable output lines.
        #[arg(long)]
        json: bool,
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
            if out.baseline_ready {
                let deltas: Vec<String> = out
                    .parts
                    .iter()
                    .filter_map(|p| {
                        p.delta_pct
                            .map(|d| format!("{} {}", p.label, blinkwell::baseline::delta_text(d)))
                    })
                    .collect();
                if !deltas.is_empty() {
                    println!("  vs your usual: {}", deltas.join(" · "));
                }
            }
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

/// Low-confidence abstain: a compact block — metrics from a mostly-failed
/// check would only mislead. Nothing is saved or learned.
fn print_abstain_card(r: &QuickCheckResult) {
    let bar = "─".repeat(52);
    println!("{bar}");
    println!("  Not enough usable footage — nothing saved, score unchanged.");
    println!(
        "  ({:.0} s usable of {:.0} s captured · confidence: {})",
        r.quality_ms / 1000.0,
        r.duration_ms / 1000.0,
        r.confidence.as_str()
    );
    for reason in &r.confidence_reasons {
        println!("    - {} → {}", reason.text, reason.fix);
    }
    println!("  Face the camera with decent light; the check pauses whenever you look away.");
    println!("{bar}");
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
            print_abstain_card(&r);
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
            "blinkwell check — {seconds:.0} s of usable footage; it pauses if your face leaves view \
             (camera LED on = it's really on)"
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

    // libmediapipe embeds a telemetry uploader thread that can SIGSEGV a
    // long-lived process (catch_unwind can't help — it's a native thread).
    // Each window therefore runs in a short-lived `__window` child process:
    // a crash costs one window, never the monitor. Short-lived children also
    // exit before the uploader's retry timer ever fires. The parent keeps no
    // engine at all — camera + model fully unload between windows.
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
            let outcome = run_window_child(
                model,
                camera,
                window_s,
                window_ms,
                cancel.clone(),
                |ems, n| {
                    if json {
                        println!(
                            "{}",
                            serde_json::json!({"type":"progress","window":win_n,"elapsedMs":ems,"frames":n})
                        );
                    } else {
                        print!(
                            "\r  window {win_n} {:6.1}s  frames {:<5} {:<40}",
                            ems / 1000.0,
                            n,
                            ""
                        );
                        let _ = std::io::stdout().flush();
                    }
                },
            );
            if !json {
                println!();
            }
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let mut r = match outcome {
                WindowOutcome::Result(r) => *r,
                WindowOutcome::Failed(why) => {
                    if json {
                        println!(
                            "{}",
                            serde_json::json!({"type":"window","window":win_n,"dropped":true,"error":why})
                        );
                    } else {
                        println!("  window {win_n}: {why} — dropped, monitor continues");
                    }
                    next_window_at = now_ms() + interval_ms;
                    continue;
                }
            };
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
                // Show why it dropped — "low confidence" alone teaches nothing.
                let why = r
                    .confidence_reasons
                    .first()
                    .map(|c| format!(" — {}", c.text.to_lowercase()))
                    .unwrap_or_default();
                println!("  window {win_n}: low confidence — dropped, not saved{why}");
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

    if !json {
        println!("\nmonitor stopped after {windows_done} window(s).");
    }
    Ok(())
}

// ------------------------------------------------- supervised window child --

enum WindowOutcome {
    Result(Box<QuickCheckResult>),
    /// Why the window produced no result (spawn error, crash, timeout).
    Failed(String),
}

/// Spawn `blinkwell __window` and stream its JSON lines: `progress` lines
/// feed `on_progress`, the final `result` line becomes the outcome. A native
/// crash inside the child (e.g. libmediapipe's uploader) surfaces as a
/// non-zero exit / closed stdout — one window lost, monitor survives.
fn run_window_child(
    model: &Option<PathBuf>,
    camera: u32,
    window_s: f64,
    window_ms: f64,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64, u64),
) -> WindowOutcome {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => return WindowOutcome::Failed(format!("cannot locate own exe: {e}")),
    };
    let mut cmd = Command::new(exe);
    cmd.arg("__window")
        .arg("--window-s")
        .arg(format!("{window_s}"))
        .arg("--camera")
        .arg(camera.to_string());
    if let Some(m) = model {
        cmd.arg("--model").arg(m);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return WindowOutcome::Failed(format!("cannot spawn window child: {e}")),
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return WindowOutcome::Failed("child stdout unavailable".into()),
    };
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    // Child's own cap is window_ms*2.5 wall-clock; the watchdog adds slack
    // for engine/model warmup so the parent can never hang on a stuck child.
    let deadline = now_ms() + window_ms * 2.5 + 90_000.0;
    let mut result: Option<QuickCheckResult> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("progress") => on_progress(
                            v["elapsedMs"].as_f64().unwrap_or(0.0),
                            v["frames"].as_u64().unwrap_or(0),
                        ),
                        Some("result") => result = serde_json::from_value(v["result"].clone()).ok(),
                        _ => {}
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            break;
        }
        if now_ms() > deadline {
            let _ = child.kill();
            return WindowOutcome::Failed("timed out".into());
        }
    }
    match child.wait() {
        Ok(st) if st.success() => match result {
            Some(r) => WindowOutcome::Result(Box::new(r)),
            None => WindowOutcome::Failed("produced no result".into()),
        },
        Ok(st) => WindowOutcome::Failed(match st.code() {
            Some(c) => format!("crashed (exit {c})"),
            None => "crashed (killed by signal)".into(),
        }),
        Err(e) => WindowOutcome::Failed(format!("wait failed: {e}")),
    }
}

/// `blinkwell __window` — one usable-time capture window as JSON lines:
/// {"type":"progress",...} ticks then a final {"type":"result",result:{…}}.
/// Used only by `monitor` (see run_window_child).
fn cmd_window(window_s: f64, camera: u32, model: &Option<PathBuf>) -> Result<()> {
    let model_path = model_path(model);
    let mut engine = LandmarkerEngine::new(&model_path)?;
    let cancel = cancel_flag();
    let mut agg = QuickCheckAggregator::new();
    // Usable-time target: window_s + 2 s slack so --window-s 60 clears the
    // 60 s medium-confidence floor (camera warmup isn't footage).
    let usable_target = window_s * 1000.0 + 2_000.0;
    let mut last_status = -f64::INFINITY;
    capture::run_camera_aligned(
        &mut engine,
        camera,
        usable_target,
        0.0, // no alignment guide — background window
        false,
        Some(cancel),
        &mut |out: &FrameOut| {
            if out.elapsed_ms - last_status >= 5000.0 || out.n == 1 {
                last_status = out.elapsed_ms;
                println!(
                    "{}",
                    serde_json::json!({"type":"progress","elapsedMs":out.elapsed_ms,"frames":out.n})
                );
                let _ = std::io::stdout().flush();
            }
            agg.push(&out.features)
        },
    )?;
    let r = agg.result(Source::Monitor);
    println!("{}", serde_json::json!({"type":"result","result":r}));
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

const METRICS: &[(&str, &str, &str)] = &[
    // (flag, label, unit)
    ("score", "fatigue score", ""),
    ("blinks", "blink rate", "/min"),
    ("partial", "partial-blink share", "%"),
    ("perclos", "PERCLOS", "%"),
    ("blinkms", "mean blink duration", "ms"),
    ("reopen", "lid reopen share", "%"),
    ("dist", "screen distance", "cm"),
    ("usable", "usable capture", "s"),
];

fn metric_val(s: &QuickCheckResult, m: &str) -> Option<f64> {
    match m {
        "score" => s.fatigue_score,
        "blinks" => Some(s.blink_rate),
        "partial" => Some(s.incomplete_ratio * 100.0),
        "perclos" => Some(s.perclos * 100.0),
        "blinkms" => Some(s.mean_blink_ms),
        "reopen" => Some(s.mean_reopen_frac * 100.0),
        "dist" => Some(s.distance_cm),
        "usable" => Some(s.quality_ms / 1000.0),
        _ => None,
    }
}

fn local_dt(s: &str) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&chrono::Local))
}

/// Group key + display label, matching report.html's grouping.
fn group_key(s: &QuickCheckResult, group: &str) -> (String, String) {
    let Some(dt) = local_dt(&s.started_at) else {
        let k = s.started_at.get(..16).unwrap_or(&s.started_at).to_string();
        return (k.clone(), k);
    };
    match group {
        "day" => (
            dt.format("%Y-%m-%d").to_string(),
            dt.format("%m-%d").to_string(),
        ),
        "halfday" => {
            let am = dt.format("%p").to_string() == "AM";
            (
                format!("{} {}", dt.format("%Y-%m-%d"), if am { "AM" } else { "PM" }),
                format!("{} {}", dt.format("%m-%d"), if am { "AM" } else { "PM" }),
            )
        }
        _ => (
            s.started_at.clone(),
            dt.format("%Y-%m-%d %H:%M").to_string(),
        ),
    }
}

fn cmd_history(n: usize, days: u32, group: &str, metric: &str) -> Result<()> {
    if !["session", "halfday", "day"].contains(&group) {
        anyhow::bail!("unknown --group '{group}' — use session | halfday | day");
    }
    let Some(&(metric_key, metric_label, unit)) = METRICS.iter().find(|(k, ..)| *k == metric)
    else {
        anyhow::bail!(
            "unknown --metric '{metric}' — use {}",
            METRICS.iter().map(|m| m.0).collect::<Vec<_>>().join(" | ")
        );
    };

    let mut sessions = storage::list_sessions();
    if sessions.is_empty() {
        println!("no saved checks yet — run `blinkwell check`");
        return Ok(());
    }
    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    if days > 0 {
        let cutoff = chrono::Local::now() - chrono::Duration::days(days as i64);
        sessions.retain(|s| local_dt(&s.started_at).is_some_and(|d| d >= cutoff));
        if sessions.is_empty() {
            println!("no saved checks in the last {days} days");
            return Ok(());
        }
    }

    // ---- summary line (mirrors the report's stat cards) -------------------
    let scores: Vec<f64> = sessions.iter().filter_map(|s| s.fatigue_score).collect();
    let n_days = sessions
        .iter()
        .filter_map(|s| local_dt(&s.started_at).map(|d| d.format("%Y-%m-%d").to_string()))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    print!(
        "blinkwell history — {} check{} · {n_days} day{}",
        sessions.len(),
        if sessions.len() == 1 { "" } else { "s" },
        if n_days == 1 { "" } else { "s" }
    );
    if !scores.is_empty() {
        let avg = scores.iter().sum::<f64>() / scores.len() as f64;
        print!(
            " · avg {avg:.0} · best {:.0} · worst {:.0}",
            scores.iter().cloned().fold(f64::INFINITY, f64::min),
            scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
        );
    }
    println!();

    // ---- grouped bars -----------------------------------------------------
    let mut groups: Vec<(String, String, Vec<&QuickCheckResult>)> = Vec::new();
    for s in &sessions {
        let (k, label) = group_key(s, group);
        match groups.last_mut() {
            Some((gk, _, v)) if *gk == k => v.push(s),
            _ => groups.push((k, label, vec![s])),
        }
    }
    let groups: Vec<_> = groups.into_iter().rev().take(n).rev().collect();
    let vals: Vec<Option<f64>> = groups
        .iter()
        .map(|(.., v)| {
            let vs: Vec<f64> = v.iter().filter_map(|s| metric_val(s, metric_key)).collect();
            (!vs.is_empty()).then(|| vs.iter().sum::<f64>() / vs.len() as f64)
        })
        .collect();
    let vmax = vals.iter().flatten().cloned().fold(0.0_f64, f64::max);
    const BARW: usize = 28;
    let labw = groups
        .iter()
        .map(|(_, l, _)| l.chars().count())
        .max()
        .unwrap_or(0);
    println!(
        "\n  {metric_label}{}",
        if unit.is_empty() {
            String::new()
        } else {
            format!(" ({unit})")
        }
    );
    for ((_, label, members), v) in groups.iter().zip(&vals) {
        match v {
            Some(v) if vmax > 0.0 => {
                let w = ((v / vmax) * BARW as f64).round().max(1.0) as usize;
                let sev = if metric_key == "score" {
                    if *v >= 60.0 {
                        "  [HIGH]"
                    } else if *v >= 35.0 {
                        "  [WARN]"
                    } else {
                        ""
                    }
                } else {
                    ""
                };
                println!("  {label:<labw$}  {}{:>7.1}{unit}{sev}", "█".repeat(w), v);
            }
            _ => println!("  {label:<labw$}  —",),
        }
        let _ = members;
    }
    if groups.iter().any(|(_, _, v)| v.len() > 1) {
        println!("  (groups show the mean of their checks)");
    }

    // ---- detail table -----------------------------------------------------
    println!(
        "\n  {:<16} {:>5} {:>6} {:>7} {:>7} {:>7} {:>6} {:>5} {:>6}  conf",
        "when", "score", "b/min", "partial", "perclos", "blinkms", "reopen", "dist", "usable"
    );
    for s in sessions.iter().rev().take(n) {
        let when = local_dt(&s.started_at)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| s.started_at.clone());
        println!(
            "  {when:<16} {:>5} {:>6.1} {:>6.0}% {:>6.1}% {:>7.0} {:>5.0}% {:>5.0} {:>6.0}  {:?}",
            s.fatigue_score
                .map(|x| format!("{x:.0}"))
                .unwrap_or_else(|| "—".into()),
            s.blink_rate,
            s.incomplete_ratio * 100.0,
            s.perclos * 100.0,
            s.mean_blink_ms,
            s.mean_reopen_frac * 100.0,
            s.distance_cm,
            s.quality_ms / 1000.0,
            s.confidence
        );
    }
    Ok(())
}

fn main() {
    // Silence native-lib logging (absl/TFLite writes straight to fd 2).
    blinkwell::stderr_filter::install();
    let cli = Cli::parse();
    let result = match &cli.cmd {
        // Bare `blinkwell`: yes/no entry point — no flags to learn.
        None => {
            print!("blinkwell — start monitoring now? (60 s camera every 10 min) [Y/n] ");
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
        Some(Cmd::History {
            n,
            days,
            group,
            metric,
        }) => cmd_history(*n, *days, group, metric),
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
        Some(Cmd::Window {
            window_s,
            camera,
            model,
        }) => cmd_window(*window_s, *camera, model),
        Some(Cmd::Replay {
            video,
            json,
            model,
            ffmpeg,
        }) => cmd_replay(video, *json, model, ffmpeg),
        Some(Cmd::Update { json }) => cmd_update(*json),
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

// ------------------------------------------------------------ self-update --

/// GitHub repo that owns the release assets (`OWNER/REPO`); BLINKWELL_REPO
/// overrides for forks/tests. Same value the installers hardcode.
const UPDATE_REPO: &str = "santpandey/eye-strain-detection";

/// `x.y.z` → sortable tuple, tolerant of a leading 'v' and missing parts.
fn version_key(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let f = |s: Option<&str>| s.and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    (f(it.next()), f(it.next()), f(it.next()))
}

/// Release asset name for this build's OS/arch, e.g.
/// `blinkwell-windows-x64.zip`. None on platforms the workflow doesn't ship
/// (linux-arm64, intel mac → those users take the pip package).
fn update_asset_name() -> Option<String> {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        return None;
    };
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    Some(format!("blinkwell-{os}-{arch}.{ext}"))
}

/// curl → captured stdout. curl is our zero-dep HTTP tool (same pattern as
/// the ffmpeg subprocess in replay): ships with Windows 10+, macOS and every
/// linux distro. If the spawn itself fails (curl absent — minimal distros,
/// containers), wget is the universal fallback.
fn fetch_text(url: &str) -> Result<String> {
    // BLINKWELL_GITHUB_TOKEN authenticates the API call — the unauthenticated
    // 60/hr/IP rate limit is easily exhausted on shared egress (CI runners,
    // corp proxies).
    let token = std::env::var("BLINKWELL_GITHUB_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    let auth = format!("Authorization: Bearer {token}");
    let mut curl_args = vec!["-fsSL", "-H", "User-Agent: blinkwell"];
    if !token.is_empty() {
        curl_args.extend(["-H", auth.as_str()]);
    }
    curl_args.push(url);
    match Command::new("curl").args(&curl_args).output() {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(out) => bail!("{}", String::from_utf8_lossy(&out.stderr).trim()),
        Err(_) => {
            let mut wget_args = vec!["-qO-"];
            if !token.is_empty() {
                wget_args.extend(["--header", auth.as_str()]);
            }
            wget_args.push(url);
            let out = Command::new("wget")
                .args(&wget_args)
                .output()
                .context("need curl or wget to update — or use the website installer")?;
            if !out.status.success() {
                bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
    }
}

/// Download `url` to `dest` with a single-line progress bar (suppressed in
/// quiet/--json mode). Same curl→wget fallback as fetch_text.
fn download(url: &str, dest: &Path, quiet: bool) -> Result<()> {
    let curl_args: &[&str] = if quiet {
        &["-fsSL", "-o"]
    } else {
        &["-fL", "-sS", "--progress-bar", "-o"]
    };
    let st = match Command::new("curl")
        .args(curl_args)
        .arg(dest)
        .arg(url)
        .status()
    {
        Ok(st) => st,
        Err(_) => {
            let wget_args: &[&str] = if quiet {
                &["-q", "-O"]
            } else {
                &["-q", "--show-progress", "-O"]
            };
            Command::new("wget")
                .args(wget_args)
                .arg(dest)
                .arg(url)
                .status()
                .context("need curl or wget to update — or use the website installer")?
        }
    };
    if !st.success() {
        bail!("download failed ({url})");
    }
    Ok(())
}

/// Unpack the release archive into `dir`. Windows → PowerShell
/// Expand-Archive (PATH `tar` may be GNU tar under Git Bash, which can't
/// read zips; `unzip` is the fallback when powershell can't spawn). Unix →
/// tar, which every distro/macOS ships.
fn unpack(pkg: &Path, dir: &Path, asset: &str) -> Result<()> {
    #[cfg(windows)]
    let st = match Command::new("powershell")
        .args(["-NoProfile", "-Command"])
        .arg(format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            pkg.display(),
            dir.display()
        ))
        .status()
    {
        Ok(s) => s,
        Err(_) => Command::new("unzip")
            .args(["-o", "-q"])
            .arg(pkg)
            .arg("-d")
            .arg(dir)
            .status()
            .context("couldn't unpack the update archive (no powershell or unzip)")?,
    };
    #[cfg(not(windows))]
    let st = Command::new("tar")
        .arg("-xzf")
        .arg(pkg)
        .arg("-C")
        .arg(dir)
        .status()
        .context("tar not found — needed to unpack the update")?;
    if !st.success() {
        bail!("couldn't unpack {asset}");
    }
    Ok(())
}

/// `blinkwell update`: fetch the newest GitHub Release and swap this binary
/// in place. Windows can't overwrite a running exe but CAN rename it, so we
/// rename the old one aside (cleaned up on the next update) and move the new
/// one into its spot; on unix rename simply replaces.
fn cmd_update(json: bool) -> Result<()> {
    let say = |msg: &str| {
        if !json {
            println!("{msg}");
        }
    };

    // Python installs (pipx/uv) shouldn't self-update: their exe is a tiny
    // launcher owned by the package manager, and uvx resolves the latest
    // version on every run anyway.
    let exe = std::env::current_exe().context("locating this executable")?;
    let near_python = exe
        .ancestors()
        .take(3)
        .any(|d| d.join("pyvenv.cfg").exists());
    if near_python {
        say("blinkwell: this install came via a Python package manager — run:");
        say("    pipx upgrade blinkwell    # pipx installs");
        say("    # uvx always fetches the latest version automatically");
        return Ok(());
    }

    // Latest release tag → compare with this build's version.
    let repo = std::env::var("BLINKWELL_REPO").unwrap_or_else(|_| UPDATE_REPO.to_string());
    let api = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = fetch_text(&api).context("fetching the latest release info")?;
    let tag = serde_json::from_str::<serde_json::Value>(&body)
        .context("release API returned unexpected JSON")?["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    if tag.is_empty() {
        bail!("release API returned no tag_name");
    }
    let cur = env!("CARGO_PKG_VERSION");
    if json {
        println!(
            "{{\"type\":\"update\",\"current\":\"{cur}\",\"latest\":\"{tag}\",\
             \"updateAvailable\":{}}}",
            version_key(&tag) > version_key(cur)
        );
    }
    if version_key(&tag) <= version_key(cur) {
        say(&format!("blinkwell is up to date (v{cur})"));
        return Ok(());
    }
    let asset = update_asset_name()
        .context("no prebuilt binary for this platform — use `uvx blinkwell` instead")?;
    let url = format!("https://github.com/{repo}/releases/latest/download/{asset}");
    say(&format!("blinkwell v{cur} → v{tag}"));

    // Download + unpack into a scratch dir.
    let dir = std::env::temp_dir().join(format!("blinkwell-update-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir)?;
    let pkg = dir.join(&asset);
    download(&url, &pkg, json)?;
    unpack(&pkg, &dir, &asset)?;
    let new = dir.join(if cfg!(windows) {
        "blinkwell.exe"
    } else {
        "blinkwell"
    });
    if !new.exists() {
        bail!("update archive didn't contain the blinkwell binary");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&new, fs::Permissions::from_mode(0o755))?;
    }

    // Swap in place; roll back if the move fails.
    let old = exe.with_extension("old");
    let _ = fs::remove_file(&old); // stale backup from a previous update
    fs::rename(&exe, &old).with_context(|| {
        format!(
            "can't move {} aside — is it write-protected?",
            exe.display()
        )
    })?;
    if let Err(e) = fs::rename(&new, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(e).with_context(|| format!("can't install to {}", exe.display()));
    }
    let _ = fs::remove_dir_all(&dir);
    say(&format!(
        "blinkwell updated to v{tag} — restart it to use the new version"
    ));
    Ok(())
}
