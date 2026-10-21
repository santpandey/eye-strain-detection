"""eyefd CLI — the app's analysis pipeline as a local process.

Commands:
  check    live quick check (camera on for --seconds, then the result card)
  monitor  periodic ~60 s camera windows every ~15 min; camera LED is ON only
           during a window — between windows cv2.VideoCapture is released
  replay   run a video file through the same pipeline (source 'file')
  trace    replay a recorded trace JSON through the Python pipeline and score
           it against labels (parity tool for scripts/eval-trace.ts)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from .config import CFG
from .eval import match_blinks
from .monitorRules import evaluate_reminders
from .notify import send_notification
from .quality import guidance_for
from .scoreSession import score_and_learn
from .session import QuickCheckAggregator
from .storage import save_session
from .thresholds import DISCLAIMER, overall_verdict


def _fix_console_encoding() -> None:
    """Windows consoles are often cp1252; Git Bash (MSYSTEM) / Windows Terminal
    (WT_SESSION) render UTF-8, so switch them to it. Elsewhere keep the native
    encoding but never crash on unencodable characters."""
    for s in (sys.stdout, sys.stderr):
        try:
            enc = (s.encoding or "").lower()
            if "utf" in enc:
                continue
            if os.environ.get("MSYSTEM") or os.environ.get("WT_SESSION"):
                s.reconfigure(encoding="utf-8", errors="replace")
            else:
                s.reconfigure(errors="replace")
        except Exception:
            pass


def _now_ms() -> float:
    return time.time() * 1000


def _model_path(args) -> Path:
    from .capture import default_model_path

    return Path(args.model) if getattr(args, "model", None) else default_model_path()


def _fmt_metric(name: str, value: str, status: str) -> str:
    tag = {"good": " ok ", "watch": "WARN", "high": "HIGH", "na": "  — "}.get(status, "    ")
    return f"  [{tag}] {name:<28} {value}"


def _fmt_ms(v: float) -> str:
    return f"{v:,.0f} ms"


def print_result_card(r: dict, score_out: dict | None = None, saved: bool = True) -> None:
    """Human-readable result card: verdict, score, metrics, tips, disclaimer."""
    st = r["statuses"]
    print("─" * 52)
    print(f"  {overall_verdict(st)}")
    if score_out is not None:
        score = score_out["score"]
        if score is not None:
            anchor = "personal baseline" if score_out["baselineReady"] else "population estimate"
            print(f"  Fatigue score: {score}/100  ({anchor})")
    elif r.get("fatigueScore") is not None:
        print(f"  Fatigue score: {r['fatigueScore']}/100")
    print("─" * 52)
    print(
        _fmt_metric(
            f"blink rate ({r['blinkRateLow']:.0f}–{r['blinkRateHigh']:.0f})",
            f"{r['blinkRate']:.1f}/min",
            st["blinkRate"],
        )
    )
    print(
        f"        {'blinks (complete)':<28} "
        f"{r['completeBlinks'] + r['incompleteBlinks']} ({r['completeBlinks']})"
    )
    print(_fmt_metric("partial-blink share", f"{r['incompleteRatio']:.2f}", st["incompleteRatio"]))
    print(_fmt_metric("mean blink duration", _fmt_ms(r["meanBlinkMs"]), st["meanBlinkMs"]))
    print(_fmt_metric("lid reopen share", f"{r['meanReopenFrac']:.2f}", st["reopenFrac"]))
    print(_fmt_metric("PERCLOS (eyes closed)", f"{r['perclos'] * 100:.1f}%", st["perclos"]))
    print(_fmt_metric("longest blink-free gap", f"{r['maxIbiMs'] / 1000:.0f} s", st["maxIbiMs"]))
    dist = f"{r['distanceCm']:.0f} cm" if st["distanceCm"] != "na" else "n/a (file)"
    print(_fmt_metric("screen distance", dist, st["distanceCm"]))
    print(_fmt_metric("face brightness", f"{r['luma']:.0f}", st["luma"]))
    print("─" * 52)
    extra = []
    if r["longClosures"]:
        extra.append(f"{r['longClosures']} long closure(s)")
    if r["yawns"]:
        extra.append(f"{r['yawns']} yawn(s)")
    if r["gazeDownDiscards"] or r["asymmetricDiscards"]:
        extra.append(
            f"discards: {r['gazeDownDiscards']} gaze-down, {r['asymmetricDiscards']} one-sided"
        )
    if extra:
        print("  " + " · ".join(extra))
    print(
        f"  confidence: {r['confidence']}  "
        f"({r['qualityMs'] / 1000:.0f} s usable of {r['durationMs'] / 1000:.0f} s, "
        f"fps avg {r['fpsMean']:.1f}, glare {r['glarePct']:.0f}%, backlit {r['backlitPct']:.0f}%)"
    )
    for reason in r["confidenceReasons"]:
        print(f"    - {reason['text']} → {reason['fix']}")
    if not saved:
        print("  not saved — confidence too low to trust (the app 'abstains' the same way)")
    for tip in r["tips"]:
        print(f"  tip: {tip}")
    print(f"  {DISCLAIMER}")
    print("─" * 52)


def _run_capture(engine, source_iter, json_mode: bool, source: str, status_prefix: str = ""):
    """Feed a FrameFeatures iterator into a fresh aggregator; progress lines
    unless --json. Returns (result, aggregator)."""
    agg = QuickCheckAggregator()
    last_status = [0.0]

    def on_frame(f, n, elapsed):
        if json_mode:
            return
        if elapsed - last_status[0] >= 5000 or n == 1:
            last_status[0] = elapsed
            v = agg.quality.last
            note = guidance_for(v, "tracking") if v else "…"
            print(
                f"\r{status_prefix}{elapsed / 1000:6.1f}s  frames {n:<5} {note:<58}",
                end="",
                flush=True,
            )

    for f in source_iter(engine=engine, on_frame=on_frame):
        agg.push(f)
    if not json_mode:
        print()
    r = agg.result(source)
    return r, agg


def _finish_result(r: dict, source: str, json_mode: bool) -> dict:
    """Shared check/replay tail: abstain on low confidence, else
    score vs baseline → learn → save (same order as the app)."""
    if r["confidence"] == "low":
        if json_mode:
            print(json.dumps({"type": "result", "saved": False, "result": r}))
        else:
            print_result_card(r, None, saved=False)
        return r
    view = score_and_learn(r)
    try:
        save_session(r)
        saved = True
    except Exception:
        saved = False
    if json_mode:
        print(json.dumps({"type": "result", "saved": saved, "result": r}))
    else:
        print_result_card(r, view["out"], saved=saved)
    return r


def cmd_check(args) -> int:
    from .capture import LandmarkerEngine, iter_camera_features

    seconds = args.seconds
    engine = LandmarkerEngine(_model_path(args))
    try:
        if not args.json:
            print(
                f"eyefd check — camera on for {seconds:.0f} s (webcam light on = honest signal)"
            )
        r, _ = _run_capture(
            engine,
            lambda engine, on_frame: iter_camera_features(
                engine, args.camera, seconds * 1000, on_frame
            ),
            args.json,
            "camera",
            status_prefix="check  ",
        )
    finally:
        engine.close()
    _finish_result(r, "camera", args.json)
    return 0


def cmd_replay(args) -> int:
    from .capture import LandmarkerEngine, iter_file_features

    engine = LandmarkerEngine(_model_path(args))
    try:
        if not args.json:
            print(f"eyefd replay — {args.video} (file source: distance n/a)")
        r, _ = _run_capture(
            engine,
            lambda engine, on_frame: iter_file_features(engine, args.video, on_frame),
            args.json,
            "file",
            status_prefix="replay ",
        )
    finally:
        engine.close()
    _finish_result(r, "file", args.json)
    return 0


def cmd_monitor(args) -> int:
    from .capture import LandmarkerEngine, iter_camera_features

    interval_ms = args.interval_min * 60_000
    window_ms = args.window_s * 1000
    break_every_ms = args.break_every_min * 60_000
    snooze_ms = CFG.monitorReminderSnoozeMs

    engine = LandmarkerEngine(_model_path(args))
    monitor_on_since = _now_ms()
    next_window_at = monitor_on_since + CFG.monitorStartupDelayMs
    state = {
        "lastBreakAt": None,
        "lastWindowResult": None,
        "windowsDone": 0,
    }
    snoozed_until: dict = {}
    if not args.json:
        print(
            f"eyefd monitor — {args.window_s:.0f} s camera window every {args.interval_min:.0f} min"
            f" (break nudge every {args.break_every_min:.0f} min). Ctrl+C to stop."
        )
        print("  camera LED is ON only while a window runs — that's the honest signal.")

    def refresh_reminders(now: float) -> None:
        candidates = evaluate_reminders(
            {
                "now": now,
                "monitorOnSince": monitor_on_since,
                "lastBreakAt": state["lastBreakAt"],
                "lastWindowResult": state["lastWindowResult"],
                "windowCount": state["windowsDone"],
                "breakEveryMs": break_every_ms,
            }
        )
        for c in candidates:
            # CLI has no dismiss button: printing a reminder counts as a
            # dismissal, so the kind stays quiet for the snooze interval (same
            # as a dismissed in-app card reappearing while the condition holds).
            if snoozed_until.get(c["kind"], 0) > now:
                continue
            snoozed_until[c["kind"]] = now + snooze_ms
            if args.json:
                print(json.dumps({"type": "reminder", **c}), flush=True)
            else:
                ex = c.get("exercise")
                print(f"\n[{time.strftime('%H:%M:%S')}] {c['title']}\n  {c['body']}")
                if ex:
                    from .exercises import EXERCISES

                    e = EXERCISES.get(ex)
                    if e:
                        print(f"  exercise ({e['seconds']} s): " + " ".join(e["steps"]))
            send_notification(c["title"], c["body"])

    try:
        while True:
            now = _now_ms()
            if now >= next_window_at:
                state["windowsDone"] += 1
                win_n = state["windowsDone"]
                if not args.json:
                    print(
                        f"[window {win_n} @ {time.strftime('%H:%M:%S')}] capturing {args.window_s:.0f}s…"
                    )
                agg = QuickCheckAggregator()
                try:
                    for f in iter_camera_features(engine, args.camera, window_ms):
                        agg.push(f)
                except RuntimeError as e:
                    print(f"  camera error: {e}", file=sys.stderr)
                    next_window_at = _now_ms() + interval_ms
                    continue
                r = agg.result("monitor")
                state["lastWindowResult"] = None
                if r["confidence"] != "low":
                    # Score vs pre-update baseline → learn → save (app order).
                    score_and_learn(r)
                    try:
                        save_session(r)
                    except Exception:
                        pass
                    state["lastWindowResult"] = r
                    if args.json:
                        print(json.dumps({"type": "window", "window": win_n, "result": r}), flush=True)
                    else:
                        print_result_card(r, None)
                elif args.json:
                    print(json.dumps({"type": "window", "window": win_n, "dropped": True, "result": r}), flush=True)
                else:
                    print(f"  window {win_n}: low confidence — dropped (not saved)")
                next_window_at = _now_ms() + interval_ms
            refresh_reminders(now)
            # 1 s scheduler tick (app: TICK_MS); also caps Ctrl+C latency.
            time.sleep(min(1.0, max(0.05, (next_window_at - _now_ms()) / 1000)))
    except KeyboardInterrupt:
        pass
    finally:
        engine.close()
        if not args.json:
            print(f"\nmonitor stopped after {state['windowsDone']} window(s).")
    return 0


def _load_trace_frames(path: str) -> list:
    from .features import FrameFeatures

    j = json.loads(Path(path).read_text(encoding="utf-8"))
    frames = (j.get("trace") or {}).get("frames") or j.get("frames")
    if not isinstance(frames, list):
        raise SystemExit(f"{path}: no frames / trace.frames array")
    return [FrameFeatures.from_dict(f) for f in frames]


def _load_labels(path: str) -> list:
    j = json.loads(Path(path).read_text(encoding="utf-8"))
    return [b["t"] for b in j["blinks"]]


def cmd_trace(args) -> int:
    """Offline replay of a recorded trace through QualityCtx + BlinkDetector —
    the Python twin of scripts/eval-trace.ts (default mode)."""
    tol = args.tol
    labels = _load_labels(args.labels) if args.labels else None
    any_fail = False
    for trace_path in args.traces:
        frames = _load_trace_frames(trace_path)
        agg = QuickCheckAggregator()
        for f in frames:
            agg.push(f)
        det = agg.detector
        det.finish()
        r = agg.result("file")
        name = Path(trace_path).name

        if args.json:
            out = {
                "type": "trace",
                "trace": name,
                "events": [e.to_dict() for e in det.events],
                "qualityMs": det.quality_ms,
                "gazeDownDiscards": det.gaze_down_discards,
                "asymmetricDiscards": det.asymmetric_discards,
                "result": r,
            }
            if labels is not None:
                out["match"] = {
                    k: v
                    for k, v in match_blinks(
                        det.events, labels, det.quality_ms / 60000, tol
                    ).items()
                    if k not in ("labelMatches", "unmatchedEvents")
                }
            print(json.dumps(out))
            continue

        print(
            f"\n=== {name}  ({len(det.events)} events, quality {det.quality_ms / 1000:.2f} s, "
            f"discards g{det.gaze_down_discards}/a{det.asymmetric_discards})"
        )
        print(" start    end   peak  rest  closedMs  kind")
        for e in det.events:
            kind = "complete LONG" if e.complete and e.longClosure else ("complete" if e.complete else "incomplete")
            print(
                f"{e.start:7.0f} {e.end:7.0f}  {e.peak:.2f}  {e.rest:.2f}  {e.closedMs:7.0f}  {kind}"
            )
        if labels is not None:
            m = match_blinks(det.events, labels, det.quality_ms / 60000, tol)
            print(
                f"TP {m['tp']}  FP {m['fp']}  FN {m['fn']}  P {m['precision']:.3f}  "
                f"R {m['recall']:.3f}  F1 {m['f1']:.3f}   (tol {tol:.0f} ms)"
            )
            for lm in m["labelMatches"]:
                if lm["event"] is None:
                    print(f"  MISS label {lm['t']:.0f}")
            for e in m["unmatchedEvents"]:
                print(f"  FP event {e.start:.0f}–{e.end:.0f} peak {e.peak:.2f}")
        print_result_card(r, None)
    return 1 if any_fail else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="eyefd",
        description="On-device eye-fatigue monitor — the web app's analysis pipeline as a local process.",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--json", action="store_true", help="machine-readable output lines")
        p.add_argument("--model", default=None, help="override face_landmarker.task path")

    p = sub.add_parser("check", help="live quick check (camera on for --seconds)")
    p.add_argument("--seconds", type=float, default=CFG.captureMs / 1000)
    p.add_argument("--camera", type=int, default=0)
    common(p)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("monitor", help="periodic camera windows; LED off between windows")
    p.add_argument("--interval-min", type=float, default=CFG.monitorIntervalMs / 60_000)
    p.add_argument("--window-s", type=float, default=CFG.monitorWindowMs / 1000)
    p.add_argument("--break-every-min", type=float, default=CFG.monitorBreakEveryMs / 60_000)
    p.add_argument("--camera", type=int, default=0)
    common(p)
    p.set_defaults(fn=cmd_monitor)

    p = sub.add_parser("replay", help="run a video file through the same p