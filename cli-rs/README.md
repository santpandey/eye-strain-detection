# blinkwell (Rust CLI)

On-device eye-fatigue monitor — the **same analysis pipeline as the web app**
(`src/lib/analysis` + `src/lib/vision`), compiled to a Windows-first Rust
binary that can watch you in the background without a browser or a hidden-tab
throttle.

```
blinkwell check     live quick check (camera on ~90 s, then the result card)
blinkwell monitor   periodic ~60 s camera windows every ~10 min, reminders
blinkwell replay    run a video file through the same pipeline
blinkwell trace     replay a recorded trace JSON, score it against labels
```

## Privacy

Same rule as the app: **frames never leave the device and are never
persisted.** Camera frames are decoded in memory, converted to a row of
`FrameFeatures` numbers, and dropped. Only the summary `QuickCheckResult`
metrics are stored, under `~/.blinkwell/` (override with `BLINKWELL_HOME`):

- `baseline.json` — rolling personal baseline (per-metric reservoir, cap 40)
- `history.jsonl` — one JSON line per saved check

The webcam LED is the honest signal: the camera device is held open only
while a check/window runs and is released immediately after (Windows Media
Foundation shows the LED exactly then). Between monitor windows the LED is
off and nothing from the camera is buffered.

**Known caveat — MediaPipe telemetry.** The `libmediapipe` native library
(any Tasks-C-API wheel ≥ 0.10.30, including the 0.10.35 the `mediapipe`
crate fetches) contains an embedded Google usage-metrics uploader
(`portable_clearcut_uploader`) that periodically attempts connections to
`play.googleapis.com`. Google provides no opt-out; their stated mitigation
is to block the host. No frames or input data are ever sent — the payload
is anonymous API-usage metrics, and on desktop the upload typically fails
anyway (`FAILED_PRECONDITION`). For a strict zero-network guarantee, block
`play.googleapis.com` in your firewall. The Python CLI (`cli/`, pinned to
`mediapipe==0.10.21` which predates the uploader) is telemetry-free, as is
the web app (wasm path).

## Setup

```sh
cargo build --release
```

Produces `target/release/blinkwell.exe`. Two native pieces are needed at run
time:

1. **`face_landmarker.task`** (the MediaPipe model, ~30 MB). Looked up in
   this order: `--model <path>` → `models/face_landmarker.task` next to the
   exe → `public/models/face_landmarker.task` in a repo checkout.
2. **`libmediapipe`** — the MediaPipe C API shared library. The `mediapipe`
   crate dlopen's it at first use; with the `download` feature it fetches
   the official PyPI `mediapipe` wheel library on first run (SHA-256
   verified, cached under the crate's data dir). To pin a specific build,
   set `MEDIAPIPE_LIB` to the `.dll` path, or drop `libmediapipe.dll` beside
   the exe. Everything still runs locally.

```sh
cargo run --release -- check
blinkwell.exe monitor --interval-min 15 --window-s 60
```

## Commands

### `blinkwell check [--seconds 90] [--camera 0] [--json] [--model <path>]`

Opens the camera for `--seconds`, runs every frame through MediaPipe
FaceLandmarker (VIDEO mode, CPU delegate — the app's own fallback) →
`compute_frame_features` → `QualityCtx` → `BlinkDetector` →
`QuickCheckAggregator`, then prints the result card: verdict, fatigue score
vs baseline, metric table with ok/WARN/HIGH chips, tips, and the
"wellness guidance, not a medical diagnosis" disclaimer.

The result is scored against the **pre-update** baseline and only then
contributed to it — the same order the app uses. `confidence: low` results
are not saved (the app "abstains" the same way). `--json` prints one
machine-readable line instead of the card.

### `blinkwell monitor [--interval-min 15] [--window-s 60] [--break-every-min 20] [--camera 0]`

Long-running supervisor. Every `--interval-min` minutes it captures a
`--window-s` camera window — creating the camera **only for the window** and
dropping it right after, so the LED is on only while measuring. Each window
is scored/learned/saved like `check`. Between windows it prints a countdown
line roughly every 30 s.

Reminders (from `src/lib/analysis` monitor rules):

- **break** — 20-20-20 nudge every `--break-every-min` (look ~6 m/20 ft away
  for 20 s)
- **tired** — a window's fatigue score or PERCLOS/long-closure signals read
  high
- **blink** — incomplete-blink ratio high in the last window

Printed reminders count as dismissed and stay quiet for the 5 min snooze.
A Windows toast is attempted via `notify-rust`; if notifications fail the
console `[REMINDER] title — body` line is the fallback — reminder failures
never crash the loop. Ctrl+C exits cleanly (code 130) and releases the
camera.

### `blinkwell replay <video> [--ffmpeg <path>] [--json]`

Decodes the video by piping `ffmpeg -i <file> -f rawvideo -pix_fmt rgb24 -`
— ffmpeg is **not** bundled; install it on PATH or pass `--ffmpeg`. Timestamps
come from the container fps (`t = frame_index · 1000/fps`), every decoded
frame is analysed (no playback-rate scheduling), and the result is marked
`source: "file"` (distance shows n/a, same as the app's file mode).

### `blinkwell trace <trace.json>... [--labels <labels.json>] [--tol 300] [--json]`

Offline parity harness for `scripts/eval-trace.ts`: loads
`{schema, frames: [FrameFeatures]}` (also accepts `{trace:{frames:[...]}}`
diag dumps), pushes the frames through the ported `QualityCtx` +
`BlinkDetector`/`QuickCheckAggregator`, and prints every detected event
(start/end/peak/rest/closedMs/kind). With `--labels` it prints TP/FP/FN,
precision/recall/F1, misses and unmatched events using the same greedy
matching and the eval-trace default ±300 ms tolerance. `--json` emits one
machine-readable object per trace (events, result, match).

Verified parity vs `npm run eval:trace`:

| trace | TS eval-trace | blinkwell trace |
|---|---|---|
| `tests/traces/synthetic.trace.json` | 4 events, F1 1.000 | identical events & F1 |
| `eval-data/diag-20261020_152808-chromium.json` | 16 events, F1 0.710 | identical events & F1 |

## Layout

```
src/
  config.rs      every numeric threshold — keep in sync with
                 src/lib/analysis/config.ts and cli/blinkwell/config.py
  features.rs    FrameFeatures + landmark/blendshape/matrix math (features.ts)
  quality.rs     QualityCtx frame gates (quality.ts)
  blink.rs       BlinkDetector state machine (blink.ts)
  session.rs     QuickCheckAggregator → QuickCheckResult (session.ts)
  thresholds.rs  status rules, verdict, tips (thresholds.ts)
  baseline.rs    rolling personal baseline (baseline.ts)
  score.rs       fatigue score vs baseline (fatigueScore.ts)
  rules.rs       monitor reminder rules (monitor rules in the app/Python port)
  exercises.rs   20-20-20 / full-blinks / palming exercise text
  eval.rs        greedy event/label matching (eval.ts)
  storage.rs     ~/.blinkwell baseline.json + history.jsonl
  notify.rs      toast via notify-rust, [REMINDER] console fallback
  capture.rs     camera (nokhwa/MSMF) + ffmpeg pipe + MediaPipe engine
  main.rs        clap CLI: check / monitor / replay / trace
tests/blink.rs   port of tests/blink.test.ts (27 cases)
```

## Tests

```sh
cargo test            # 27 detector tests ported from tests/blink.test.ts
cargo clippy --all-targets
cargo fmt
```

## Notes / deviations from the web app

- The web app mirrors the camera preview with CSS; landmark coordinates are
  never mirrored — the CLI does the same (there is no preview at all).
- `check`/`monitor` request 640×480 @30 fps and fall back to the camera's
  best available mode (webcam-dependent), matching the app's request.
- The fatigue score needs ≥5 blink events to be non-null, and the personal
  baseline needs ≥3 saved checks (`baselineReady`).
- Windows notifications go through `notify-rust` (WinRT); on systems where
  toasts can't be delivered the console line is printed regardless.
- `--tol` on `trace` defaults to the eval-trace default (300 ms); pass
  `--tol 150` for the intra-app matching tolerance.
