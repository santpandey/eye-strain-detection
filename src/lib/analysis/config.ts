/**
 * Central tuning knobs. Every numeric threshold in the analysis pipeline lives
 * here. All values are initial values — tune with the A5 accuracy eval.
 */
export const CFG = {
  // Quality gates (initial value, tune with A5 eval)
  headPoseDeg: 20, // |yaw| or |pitch| beyond this → 'headPose'
  faceLumaMin: 45, // face-region luma below this → 'dark'
  lowFpsMin: 15, // processed fps below this → 'lowFps'
  lowFpsWindowMs: 2000,
  lowFpsMinFrames: 10, // judge fps once this many frames are in the window…
  lowFpsMinSpanMs: 1000, // …or once the window spans this long, whichever comes first
  motionMaxIowPerSec: 1.5, // nose speed in interocular-widths/s → 'motion'
  // Non-gating signals (initial value, tune with A5 eval)
  glareFrac: 0.03, // glare share above this → glare frame
  glareLumaCut: 245,
  backlitDelta: 50, // frameLuma − faceLuma above this → backlit
  // Blink detector (initial value, tune with A5 eval)
  earBaselineMs: 10_000,
  earBaselineMinSamples: 15,
  earOpenFallback: 0.28,
  // Detector v2: prominence over a local rest level (initial value, tune with A5 eval).
  // Defaults = centre of the high plateau of `npm run eval:trace -- --grid` over
  // the 3 traces of the 73 s phone clip (28 labels; one clip — don't overfit).
  restWindowMs: 3000, // rest = rolling percentile of c over this many ms of quality frames
  restPercentile: 30, // …at this percentile (0–100); frozen while an event is open
  promStart: 0.3, // open an event when c − rest exceeds this
  promEnd: 0.08, // close it when c − rest falls below this
  valleyDrop: 0.2, // split: c must fall ≥ this below the event peak…
  riseAgain: 0.2, // …then rise ≥ this above that valley → new event at the valley
  settleMs: 200, // end an event once c sits within settleBand for this long after the peak…
  settleBand: 0.05, // …(below peak − valleyDrop and the duration level); rest re-seeds there
  durationFrac: 0.5, // duration level = rest + durationFrac·(peak − rest)
  peakComplete: 0.8, // absolute peak c for a complete blink
  maxBlinkMs: 3000,
  longClosureMs: 500,
  earDropFrac: 0.6, // 60% EAR drop = fully closed
  perclosLevel: 0.8,
  dtCapMs: 100,
  // Gaze-down discard, relative to the user's own rest level (initial values,
  // tune with A5 eval). Absolute thresholds don't work: resting lookDown varies
  // per user and lids dropping reads as gaze-down at blink onset.
  gazeRestWindowMs: 5000, // rolling median lookDown over non-event frames
  gazePostOffsetMs: 100, // post-event window starts this many ms after the event end…
  gazePostMs: 400, // …and spans this long; median lookDown over it vs rest
  gazeDownRise: 0.3, // discard when post-event lookDown exceeds rest by this
  // The next blink's lid drop also reads as lookDown, so when another event
  // opens within the post window (+this pad, since detect-start lags onset)
  // the check is skipped.
  gazeNeighborPadMs: 150,
  asymmetryMax: 0.4,
  // Abstain when this share of candidates is discarded (needs ≥ min candidates)
  maxDiscardPct: 40, // initial value, tune with A5 eval
  maxDiscardMinCandidates: 5, // initial value, tune with A5 eval
  // Capture (initial value, tune with A5 eval)
  captureMs: 90_000,
  abortGapMs: 30_000,
  alignHoldMs: 1000,
  // File analysis adaptive playback (initial value, tune with A5 eval)
  fileTargetFps: 30, // processed frames per media-second (capped at the video's own fps)
  filePlaybackMin: 0.1, // slowest playbackRate used for file analysis
  // Confidence tiers (initial value, tune with A5 eval)
  confHighQualityMs: 80_000,
  confHighQualityPct: 80,
  confHighFps: 24,
  confHighGlarePct: 10,
  confHighBacklitPct: 20,
  confHighDiscardPct: 15,
  confMedQualityMs: 60_000,
  confMedQualityPct: 60,
  confMedFps: 15,
  // Per-metric minimum event counts (initial value, tune with A5 eval)
  minEventsMeanBlink: 5,
  minEventsIncomplete: 8,
  // Personal baseline (initial values — no eval coverage yet)
  baselineMinSessions: 3, // contributing saved checks before baselineReady
  baselineReservoir: 40, // per-metric reservoir cap (last N session values)
  // Composite fatigue score (initial values — no eval coverage yet)
  scoreMinEvents: 5, // total blink events below this → score null (matches minEventsMeanBlink)
  scoreSaturateK: 2, // sub-score = r/(r+K) where r = value/reference → 1/3 at reference, 1/2 at 2×
  scoreWeights: { perclos: 0.35, meanBlinkMs: 0.25, meanReopenFrac: 0.2, incompleteRatio: 0.2 },
  scoreWatch: 40, // score below this → 'good' chip
  scoreHigh: 70, // score at/above this → 'high' chip
  // Metric status thresholds (initial value, tune with A5 eval)
  blinkRateHighLow: 8,
  blinkRateWatchLow: 12,
  blinkRateWatchHigh: 22,
  blinkRateHighHigh: 30,
  incompleteWatch: 0.3,
  incompleteHigh: 0.5,
  meanBlinkWatchMs: 300,
  meanBlinkHighMs: 400,
  // Share of closed time spent reopening (Schleicher 2008: slow lid reopening
  // is a top-3 drowsiness indicator). Initial values, tune with labelled data.
  reopenFracWatch: 0.75,
  reopenFracHigh: 0.85,
  perclosWatch: 0.08,
  perclosHigh: 0.15,
  ibiWatchMs: 10_000,
  ibiHighMs: 20_000,
  distanceWatchCm: 50,
  distanceHighCm: 40,
  lumaWatch: 60,
  // Background monitor (initial values — no eval coverage yet)
  monitorIntervalMs: 900_000, // camera-on window every ~15 min
  monitorWindowMs: 60_000, // each check window runs ~1 min
  monitorBreakEveryMs: 1_200_000, // 20-20-20 break nudge every ~20 min
  monitorReminderSnoozeMs: 300_000, // a dismissed reminder stays quiet for ~5 min
  monitorStartupDelayMs: 3_000, // first window this long after the monitor is switched on
  // Eval (initial value, tune with A5 eval)
  matchTolMs: 150,
  evalTraceTolMs: 300, // default tolerance of scripts/eval-trace.ts (manual labels lag ~220 ms)
  defaultMinF1: 0.85,
} as const;
