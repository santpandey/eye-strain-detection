# Eye Fatigue Detector

Fully on-device web app (step 1 of a PWA). Webcam → MediaPipe Face Landmarker →
blink/eye metrics. No backend. The web app is also our analysis/dev harness —
the shipped product is a local CLI (see `cli/` Python reference + `cli-rs/`
Rust build); the public site is a static brochure + download link.

## Privacy rule

No frames or images ever leave the device or get persisted in step 1. Only
summary metrics (`QuickCheckResult`) are stored, in IndexedDB.

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

## Python CLI (cli/)

A faithful port of the analysis layer to a local process — no browser, no
hidden-tab problem. `cli/blinkwell/` mirrors the TS modules 1:1 (`config.py`,
`features.py`, `quality.py`, `blink.py`, `session.py`, `thresholds.py`,
`baseline.py`, `fatigueScore.py`, `eval.py`); `monitorRules.py`,
`exercises.py`, `notify.py` are ports of the removed in-browser monitor
(`src/lib/analysis/monitorRules.ts`, `src/lib/monitor/*`) — the CLI is now
their canonical home, and the five `monitor*` CFG constants are likewise
CLI-owned (deleted from config.ts). Process-side plumbing is `capture.py`
(cv2 + mediapipe), `storage.py` (`~/.blinkwell/baseline.json` + `history.jsonl`),
`scoreSession.py`, `cli.py`.

- Setup: `cd cli && py -3.11 -m venv .venv && .venv/Scripts/activate && pip install -r requirements.txt`
  (or `pip install -e .`; mediapipe is hard-pinned to 0.10.21 — later builds
  ship a native telemetry uploader that attempts network calls).
- Commands: `blinkwell check [--seconds 90] [--camera 0]`, `blinkwell monitor
  [--interval-min 15] [--window-s 60] [--break-every-min 20]` (camera LED on
  only during windows — VideoCapture released between them), `blinkwell replay
  <video>` (source 'file', distance n/a), `blinkwell trace <trace.json>
  [--labels <labels.json>] [--tol 300]` (parity with `npm run eval:trace`).
  `--json` gives machine-readable lines.
- Parity check: `cli/.venv/Scripts/python.exe -m blinkwell trace
  tests/traces/synthetic.trace.json --labels tests/traces/synthetic.labels.json`
  must reproduce `npm run eval:trace` event-for-event (verified F1-identical on
  synthetic + two eval-data diag traces).
- **Keep `cli/blinkwell/config.py` in sync with `src/lib/analysis/config.ts`** —
  every CFG constant was copied verbatim.
- Tests: `cli/.venv/Scripts/python.exe -m pytest cli/tests` (pytest; mirrors
  tests/blink.test.ts + session.test.ts).

## Delegate selection (engine.ts)

Software WebGL (SwiftShader/llvmpipe/etc., e.g. headless Chromium) → CPU.
Firefox → CPU. Otherwise GPU, then a one-time GPU-vs-CPU latency benchmark
keeps the faster (CPU must be < 0.8× GPU median). A GPU that finds no face
for 45 frames / 3 s falls back to CPU. Choices persist in localStorage
`blinkwell.delegate` as `{delegate, renderer, at, reason}` and are ignored when the
renderer string changes.

## Tuning & developer tools

- All numeric thresholds live in `src/lib/analysis/config.ts` ("initial value,
  tune with A5 eval").
- Dev mode: localStorage `blinkwell.dev=1`, Settings → Advanced → Developer tools,
  or `?dev=1`. Enables the "Download trace" button (numbers only) and the
  `#/dev/label` route (blink labeling; `B` marks, Backspace undoes).
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
  lib/eyeRoi.ts                  # eye-region clip-path ROI + smoothed tracker (privacy: preview shows eyes only)
  lib/storage/db.ts              # idb: 'eye-fatigue' DB, store 'sessions'
  lib/session/fileSession.svelte.ts  # singleton: video-file analysis (owns VisionClient + aggregator,
                                     # mini-player <video> via attachVideo; survives route changes)
  lib/components/                # Nav, Icon, StatCard, ProgressRing, AlignmentOverlay, MiniPlayer
  routes/                        # Home, Check, History, Settings
tests/                           # vitest unit tests (synthetic FrameFeatures @30fps)
```

## Conventions

- All analysis is pure functions/classes over `FrameFeatures` — unit-testable,
  no DOM or worker deps.
- Camera is mirrored with CSS only; landmark coordinates stay unmirrored, the
  overlay mirrors x when drawing.
- Alignment frame (normalized): x ∈ [0.2, 0.8], y ∈ [0.29, 0.55].
- Monitoring lives in the local CLI (`cli-rs/` product, `cli/` reference port),
  not the browser — a hidden tab can't capture frames and users won't accept a
  website holding the camera. `QuickCheckResult.source` still allows
  `'monitor'` so old monitor records render in History.
- Later steps (not built yet): PWA/service worker, redness analysis (pilot in
  `e2e/redness-pilot.spec.ts`), charts, Rust/PyInstaller packaging.

## cli-rs/ — the Rust monitor CLI (`blinkwell`)

Windows-first Rust port of the whole pipeline for background monitoring:
camera → MediaPipe FaceLandmarker (`mediapipe` crate, CPU/XNNPACK) →
`FrameFeatures` → the ported `QualityCtx`/`BlinkDetector`/`QuickCheckAggregator`
→ `QuickCheckResult`. Commands: `check` (live quick check), `monitor`
(periodic ~60 s windows; the camera device is created only during a window so
the LED is honestly off between windows), `replay` (video file via an ffmpeg
subprocess — not bundled), `trace` (offline parity harness for
`scripts/eval-trace.ts`). Same privacy rule as the app: frames are processed
in memory only; only summary metrics persist under `~/.blinkwell`
(`BLINKWELL_HOME` overrides for tests).

- Build: `cargo build -p blinkwell --release` (inside `cli-rs/` it's just
  `cargo build --release`; the crate is a standalone package named `blinkwell`).
- Needs `face_landmarker.task` (`--model`, `models/` beside the exe, or the
  repo's `public/models/` copy — else the copy embedded via `include_bytes!`
  is written to `<cache>/blinkwell/models/`) and a libmediapipe native library
  (auto-downloaded from the official PyPI wheel on first run;
  `MEDIAPIPE_LIB` or a `libmediapipe.dll` beside the exe overrides).

## Distribution (site/, workflows, installers)

- `site/` is the public brochure (px0-style): `index.html`, `install.sh`,
  `install.ps1`. Netlify publishes `site/` only (netlify.toml); the Vite app
  is a local harness and is NOT published.
- `site/install.{sh,ps1}` download `blinkwell-<os>-<arch>.{tar.gz,zip}` from
  `github.com/<REPO>/releases/latest/download/` — set the `REPO`/`$Repo`
  constant (and the `OWNER/REPO` link in site/index.html) once the GitHub
  repo exists. Single-file install: the binary embeds the model, and the
  mediapipe crate fetches libmediapipe itself on first run.
- `.github/workflows/release.yml` — on tag `v*`: matrix builds
  linux-x64 / macos-arm64 / windows-x64 / windows-arm64 → GitHub Release
  assets. No libmediapipe bundling needed (runtime download). Intel mac +
  linux-arm64 have no PyPI wheel → those users use the pip package.
- `.github/workflows/publish-pypi.yml` — on tag `v*`: `uv build` + `uv
  publish` (PyPI trusted publishing; configure the publisher on PyPI once,
  or set `PYPI_API_TOKEN`). Gives `uvx blinkwell` / `pipx install blinkwell`.
- **MediaPipe telemetry (Rust path only)**: libmediapipe from Tasks-C-API
  wheels ≥ 0.10.30 embeds a Google metrics uploader (play.googleapis.com,
  no opt-out, fails on desktop, sends no input data). No pre-uploader C
  API wheel exists, so it can't be pinned away — documented in
  cli-rs/README.md + site/index.html; users can firewall-block the host.
  Python CLI (0.10.21) and the web wasm path are telemetry-free.
- **Parity gate**: after touching `cli-rs/src/{config,features,quality,blink,
  session,thresholds,eval,baseline,score}.rs`, re-run
  `npm run eval:trace -- tests/traces/synthetic.trace.json tests/traces/synthetic.labels.json`
  and `cargo run -p blinkwell -- trace tests/traces/synthetic.trace.json --labels tests/traces/synthetic.labels.json`
  (same for `eval-data/diag-20261020_152808-chromium.json` +
  `eval-data/20261020_152808.labels.json`) and confirm identical event lists
  and TP/FP/FN.
- **`cli-rs/src/config.rs` must stay synchronized with
  `src/lib/analysis/config.ts` and `cli/blinkwell/config.py`** — the header
  comment says the same. Names match the TS (`PROM_START` = `promStart`).
- `cli-rs/tests/blink.rs` ports `tests/blink.test.ts`; keep new detector
  behaviors covered in both places.

## Release checklist — run every time before tagging

Tag pushes trigger `release.yml` (GitHub Release assets) and
`publish-pypi.yml` (PyPI). PyPI rejects re-uploaded filenames forever, so the
version bump MUST land before the tag. In order:

1. **Bump the version** in BOTH `cli/pyproject.toml` and
   `cli-rs/Cargo.toml` to the new `X.Y.Z` (keep them in sync).
2. Run `cargo check`/`build` in `cli-rs/` so `Cargo.lock` picks up the new
   version — commit the lockfile too.
3. Update the hardcoded version chip in `site/index.html` (nav, `vX.Y.Z`).
4. Verify green: `cargo fmt --check`, `cargo clippy --release`,
   `cargo test --release`, `cd cli && .venv/Scripts/python -m pytest tests/`,
   `npm test` if `src/` changed.
5. `git push` — moves `main` (Netlify redeploys `site/` on this push).
6. `git tag vX.Y.Z && git push origin vX.Y.Z` — pushes the tag ref →
   triggers both workflows. (`git push --follow-tags` combines 5+6.)
7. Check the Actions tab: `release` should produce
   `blinkwell-{linux-x64,macos-arm64,windows-x64,windows-arm64}.{tar.gz,zip}`;
   `publish-pypi` should upload `blinkwell-X.Y.Z` successfully.
8. Verify: `releases/latest/download/` asset names still match what
   `site/install.{sh,ps1}` fetch, and `pypi.org/pypi/blinkwell/json` shows
   the new version.

Hard rules learned the hard way:

- **PyPI is immutable**: a tag pointing at a commit whose pyproject version
  already exists on PyPI fails with "File already exists". Never retag to
  "re-publish" — bump the version instead.
- **Deleting a remote tag does NOT delete its GitHub Release** — if a tag
  must move, delete the Release on the releases page too, or stale assets
  persist alongside new ones.
- Re-running a failed tag-triggered workflow reuses the workflow file FROM
  THE TAG, not from main — fix the file on main, then re-run via
  `workflow_dispatch` (or move the tag).
