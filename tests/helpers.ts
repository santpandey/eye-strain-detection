import type { FrameFeatures } from '../src/lib/vision/types';
import type { QuickCheckResult } from '../src/lib/analysis/session';

export const FPS = 30;
export const DT = 1000 / FPS;

let t = 0;

export function resetClock() {
  t = 0;
}

/** A quality, eyes-open frame. Overrides let tests simulate blinks etc. */
export function frame(over: Partial<FrameFeatures> = {}): FrameFeatures {
  t += DT;
  return {
    t,
    face: true,
    earL: 0.3,
    earR: 0.3,
    blinkL: 0,
    blinkR: 0,
    squintL: 0,
    squintR: 0,
    jawOpen: 0,
    lookDown: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    irisPx: 12,
    interocularPx: 150,
    eyeCenters: [
      [0.4, 0.4],
      [0.6, 0.4],
    ],
    eyeContour: [],
    nose: [0.5, 0.5],
    frameLuma: 120,
    faceLuma: 120,
    glare: [0, 0],
    frameW: 640,
    frameH: 480,
    ...over,
  };
}

/** n open frames. */
export function open(n: number, over: Partial<FrameFeatures> = {}): FrameFeatures[] {
  return Array.from({ length: n }, () => frame(over));
}

/** n fully-closed frames (c ≈ 1). */
export function closed(n: number, over: Partial<FrameFeatures> = {}): FrameFeatures[] {
  return open(n, { earL: 0, earR: 0, blinkL: 1, blinkR: 1, ...over });
}

/** n partially-closed frames (peak c ≈ 0.6 → incomplete). */
export function halfClosed(n: number): FrameFeatures[] {
  return open(n, { earL: 0.15, earR: 0.15, blinkL: 0.4, blinkR: 0.4 });
}

/** n noisy sub-threshold frames (c ≈ 0.15 → prominence ≈ 0.15 over an open-eye rest). */
export function noise(n: number): FrameFeatures[] {
  return open(n, { earL: 0.27, earR: 0.27, blinkL: 0.13, blinkR: 0.13 });
}

export function feedAll(det: { push(f: FrameFeatures): void }, seq: FrameFeatures[]) {
  for (const f of seq) det.push(f);
}

/** Minimal valid QuickCheckResult — override per test. */
export function makeResult(over: Partial<QuickCheckResult> = {}): QuickCheckResult {
  return {
    schemaVersion: 2,
    id: 'test-id',
    startedAt: '2026-01-01T10:00:00.000Z',
    durationMs: 90_000,
    qualityMs: 85_000,
    qualityPct: 94,
    blinkRate: 15,
    blinkRateLow: 10,
    blinkRateHigh: 22,
    completeBlinks: 18,
    incompleteBlinks: 2,
    incompleteRatio: 0.1,
    meanBlinkMs: 160,
    meanReopenFrac: 0.6,
    longClosures: 0,
    perclos: 0.02,
    maxIbiMs: 6000,
    ibiOver10s: 0,
    distanceCm: 55,
    luma: 120,
    squint: 0.1,
    yawns: 0,
    fpsMean: 29,
    glarePct: 0,
    backlitPct: 0,
    gazeDownDiscards: 0,
    asymmetricDiscards: 0,
    confidence: 'high',
    confidenceReasons: [],
    tips: [],
    statuses: {
      blinkRate: 'good',
      incompleteRatio: 'good',
      meanBlinkMs: 'good',
      reopenFrac: 'good',
      perclos: 'good',
      maxIbiMs: 'good',
      distanceCm: 'good',
      luma: 'good',
    },
    source: 'camera',
    ...over,
  };
}
