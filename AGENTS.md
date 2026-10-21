# Eye Fatigue Detector

Fully on-device web app (step 1 of a PWA). Webcam → MediaPipe Face Landmarker →
blink/eye metrics. No backend.

## Privacy rule

No frames or images ever leave the device or get persisted in step 1. Only
summary metrics (`QuickCheckResult`) are stored, in IndexedDB.

Background monitor invariant: between its periodic ~60 s windows the camera
tracks are fully released (`VisionClient.releaseCamera()` — stream stopped,
`srcObject` cleared, webcam LED off). The stream is never kept alive between
windows, and a window never runs while the page is hidden.

## Stack

- Vite + Svelte 5 (runes) + TypeScript, manual setup
- `@mediapipe/tasks-vision@1.1.0` (exact pin) — wasm copied to
  `public/mediapipe/wasm` by `scripts/copy-mediapipe.mjs` (postinstall/prebuild);
  model committed at `public/models/face_landmarker.task`
- `idb` for storage; no other runtime deps, no UI kit/router/fonts

- Requires Node >= 22.12 (`engines` in package.json).
- `npm install` must work with no flags — Vite 7 + vite-plugin-svelte 6 was
  chosen because the Vite 8/plugin-svelte 7 combo crashes npm 10.9's arborist.

## Commands

- `npm run dev` — dev server (port 5173)
- `npm run build` — production build
- `npm run preview` — serve the build
- `npm run check` — svelte-check
- `npm test` — vitest run (tests/)
- `npm run test:e2e` — Playwright smoke tests (e2e/), needs `npx playwright install chromium`
- `EVAL_DIR=eval-data npm run eval` — accuracy harness: for every
  `<name>.<mp4|webm|mov>` in EVAL_DIR with a sibling `<name>.labels.json`,
  runs the file through the app and writes `eval-report.{json,md}`
- `npm run eval:trace -- <trace.json>... <labels.json> [--tol 300] [--grid]` —
  offline (no browser) replay of recorded traces through QualityCtx +
  BlinkDetector, scored against labels; `--grid` searches detector thresholds
- `DIAG_VIDEO=<file> npx playwright test e2e/diag.spec.ts --project=chromium|firefox`
  — runs a real clip through the app and writes `eval-data/diag-<browser>.json`
  (per-frame trace, delegate, renderer). Don't edit `src/` during a run: Vite
  HMR reloads the page and spoils it.

## Delegate selection (engine.ts)

Software WebGL (SwiftShader/llvmpipe/etc., e.g. headless Chromium) → CPU.
Firefox → CPU. Otherwise GPU, then a one-time GPU-vs-CPU latency benchmark
keeps the faster (CPU must be < 0.8× GPU median). A GPU that finds no face
for 45 frames / 3 s falls back to CPU. Choices persist in localStorage
`eyefd.delegate` as `{delegate, renderer, at, reason}` and are ignored when the
renderer string changes.

## Tuning & developer tools

- All numeric thresholds live in `src/lib/analysis/config.ts` ("initial value,
  tune with A5 eval").
- Dev mode: localStorage `eyefd.dev=1`, Settings → Advanced → Developer tools,
  or `?dev=1`. Enables the "Download trace" button (numbers only), the
  `#/dev/label` route (blink labeling; `B` marks, Backspace undoes), and the
  `eyefd.monitorCfg` localStorage JSON override
  `{intervalMs, windowMs, breakEveryMs}` — short monitor timers for e2e/dev.
- `tests/traces/*.trace.json` + sibling `*.labels.json` are replayed by
  `tests/traces.test.ts` (F1 ≥ labels.minF1 ?? 0.85). Regenerate the synthetic
  fixture with `node scripts/make-synthetic-trace.mjs`.

## Layout

```
src/
  main.ts, App.svelte            # shell + tiny hash router (#/, #/check, #/history, #/settings)
  styles/tokens.css, base.css    # theme tokens (light/dark) + base styles
  lib/vision/engine.ts           # FaceLandmarker setup + per-frame processing
  lib/vision/worker.ts           # Web Worker wrapper around engine
  lib/vision/client.ts           # camera/file sources, frame loop, 1-frame backpressure, worker→main
                                 # fallback; releaseCamera() drops tracks but keeps the backend alive
  lib/vision/features.ts         # pure: landmarks/blendshapes/matrix -> FrameFeatures
  lib/analysis/config.ts         # every numeric threshold ("tune with A5 eval")
  lib/analysis/quality.ts        # QualityCtx: frame gates (noFace/headPose/dark/lowFps/motion)
  lib/analysis/blink.ts          # pure: BlinkDetector (closure state machine, PERCLOS, discards)
  lib/analysis/session.ts        # pure: QuickCheckAggregator -> QuickCheckResult + confidence
  lib/analysis/thresholds.ts     # status rules + tips (incl. 'na' minimums)
  lib/analysis/eval.ts           # pure: matchBlinks for accuracy eval
  lib/analysis/monitorRules.ts   # pure: evaluateReminders -> break/tired/blink Reminder[] for the monitor
  lib/monitor/exercises.ts       # pure data: guided eye-rest exercises (look-far / full-blinks / palming)
  lib/monitor/notify.ts          # optional OS notifications (localStorage 'eyefd.notify' + permission)
  lib/cameraLock.ts              # module counter: Quick Check claims the camera so the monitor postpones
  lib/eyeRoi.ts                  # eye-region clip-path ROI + smoothed tracker (privacy: preview shows eyes only)
  lib/storage/db.ts              # idb: 'eye-fatigue' DB, store 'sessions'
  lib/session/fileSession.svelte.ts  # singleton: video-file analysis (owns VisionClient + aggregator,
                                     # mini-player <video> via attachVideo; survives route changes)
  lib/session/monitorSession.svelte.ts # singleton: background monitor — ~60 s camera windows every ~15 min,
                                     # camera fully released between windows; reminders + exercises
  lib/components/                # Nav, Icon, StatCard, ProgressRing, AlignmentOverlay, MiniPlayer,
                                 # MonitorWidget (bottom-LEFT: chip/preview + reminder + exercise cards)
  routes/                        # Home, Check, History, Settings
tests/                           # vitest unit tests (synthetic FrameFeatures @30fps)
```

## Conventions

- All analysis is pure functions/classes over `FrameFeatures` — unit-testable,
  no DOM or worker deps.
- Camera is mirrored with CSS only; landmark coordinates stay unmirrored, the
  overlay mirrors x when drawing.
- Alignment frame (normalized): x ∈ [0.2, 0.8], y ∈ [0.29, 0.55].
- Background monitor: opt-in per session (Home card → `monitor.start()`; never
  auto-starts). Windows run the same aggregator pipeline and save with
  `source: 'monitor'`; low-confidence windows drop silently. Windows are
  postponed ~2 min while `fileSession` analyzes or `cameraBusy()` (Quick
  Check). Reminders: in-app cards always, OS notifications behind Settings →
  Notifications (`eyefd.notify`).
- Later steps (not built yet): PWA/service worker, redness analysis (pilot in
  `e2e/redness-pilot.spec.ts`), charts.
