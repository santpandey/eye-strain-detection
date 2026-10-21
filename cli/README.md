# blinkwell — eye-fatigue monitor CLI

The [Eye Fatigue Detector](../README.md) web app's analysis pipeline as a local
process — no browser, no hidden-tab problem. Webcam → MediaPipe Face
Landmarker → blink/eye metrics → verdicts, a composite fatigue score, and
20-20-20-style reminders. Windows-first.

This is a **faithful port** of `src/lib/analysis/*` + `src/lib/vision/features.ts`
— same constants, same state machine, same quirks — not a redesign.

## Install

Requires Python ≥ 3.11 (mediapipe's safest Windows target is 3.11):

```bat
cd cli
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -e .
::  or, for the exact verified pin set:
pip install -r requirements.txt
```

`blinkwell` is then on PATH inside the venv; `python -m blinkwell` works too.
The face model is the repo's own `public/models/face_landmarker.task` —
nothing is downloaded.

## Commands

```bat
blinkwell check --seconds 90 --camera 0     :: live quick check → result card
blinkwell monitor --interval-min 15 --window-s 60 --break-every-min 20
blinkwell replay <video>                    :: run a video file through the pipeline
blinkwell trace <trace.json> --labels <labels.json> [--tol 300]
```

- `check` — camera on for `--seconds`, then the result card (verdict, fatigue
  score, per-metric statuses, tips, disclaimer). Saved to history + baseline,
  same as a saved web-app check — **except** low-confidence checks, which
  "abstain" (printed but not saved) exactly like the app.
- `monitor` — the core feature. Every `--interval-min` minutes the camera
  turns on for a `--window-s` check window and is **fully released** after it:
  `cv2.VideoCapture` opens at window start, `release()` at window end, so the
  webcam LED is off between windows. Reminder rules (`break`/`tired`/`blink`)
  print to the console and fire an OS toast via plyer (falls back to a
  `[REMINDER]` console line). Ctrl+C stops cleanly.
- `replay` — processes a video file at media-time timestamps; screen distance
  is `n/a` like the app's file source.
- `trace` — parity tool: replays a recorded app trace
  (`{"schema", "frames": [...FrameFeatures]}`, also the `trace.frames` shape of
  `eval-data/diag-*.json`) through `QualityCtx` + `BlinkDetector` and prints
  events + the result; with `--labels` it prints TP/FP/FN + P/R/F1 with the
  same matching semantics as `scripts/eval-trace.ts` (default tol 300 ms).
- `--json` on `check`/`monitor`/`replay`/`trace` prints machine-readable
  lines (one JSON object per result/window/reminder/trace).

Data lives at `~/.blinkwell/`: `baseline.json` (per-metric reservoirs + median) and
`history.jsonl` (one saved result per line). Set `EYEFD_HOME` to relocate.

## Your webcam light

The camera LED is on during checks and monitor windows — that's the honest
signal: if the light is on, frames are being read; if it's off, nothing is
looking at you. Between monitor windows the capture device is released, so the
light visibly turns off.

## Privacy

Same rule as the app: no frames or images ever leave the device or get
persisted. Only summary metrics (`QuickCheckResult` JSON) are written, to
`~/.blinkwell/` on your own disk. The face-landmarker model loads from a local
file; the code makes no network calls. (mediapipe is pinned at 0.10.21 —
later builds embed a native telemetry uploader that *attempts* upload;
0.10.21 has no such uploader.)

## Output meaning

Wellness guidance, not a medical diagnosis. Verdicts use the app's two-axis
rule: fatigue signals (PERCLOS, blink duration, lid-reopen slowness, partial
blinks) outrank task-context signals (blink rate, gaps, distance, light).

## Parity with the app

The CLI's detector output was verified event-for-event against
`npm run eval:trace` on `tests/traces/synthetic.trace.json` (4/4 events,
F1 1.000) and two real `eval-data/diag-*` traces (F1 identical to the TS
pipeline: 0.710 and 0.370). When `config.ts` is retuned, edit
`cli/blinkwell/config.py` to match — the module header says so too.

## Dev

```bat
.venv\Scripts\python -m pytest tests     :: unit tests (port of tests/*.test.ts)
```

Layout mirrors the TS modules: `config.py features.py quality.py blink.py
session.py thresholds.py baseline.py fatigueScore.py monitorRules.py
exercises.py eval.py` are 1:1 ports; `capture.py` (cv2 + mediapipe),
`storage.py` (~/.blinkwell), `scoreSession.py`, `notify.py`, `cli.py` are
process-side plumbing.
