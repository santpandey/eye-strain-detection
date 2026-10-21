import type { FrameFeatures } from '../vision/types';
import { estimateDistanceCm } from '../vision/features';
import { BlinkDetector } from './blink';
import { QualityCtx } from './quality';
import { assess, type MetricStatuses } from './thresholds';
import { CFG } from './config';

export type Confidence = 'high' | 'medium' | 'low';

export interface ConfidenceReason {
  text: string;
  fix: string;
}

export interface QuickCheckResult {
  schemaVersion: 2;
  id: string;
  startedAt: string;
  durationMs: number;
  qualityMs: number;
  qualityPct: number;
  blinkRate: number;
  blinkRateLow: number;
  blinkRateHigh: number;
  completeBlinks: number;
  incompleteBlinks: number;
  incompleteRatio: number;
  meanBlinkMs: number;
  /** Mean share of each blink's closed time spent reopening (0–1). */
  meanReopenFrac: number;
  longClosures: number;
  perclos: number;
  maxIbiMs: number;
  ibiOver10s: number;
  distanceCm: number;
  luma: number;
  squint: number;
  yawns: number;
  fpsMean: number;
  glarePct: number;
  backlitPct: number;
  gazeDownDiscards: number;
  asymmetricDiscards: number;
  confidence: Confidence;
  confidenceReasons: ConfidenceReason[];
  tips: string[];
  statuses: MetricStatuses;
  source?: 'camera' | 'file' | 'monitor';
  selfReport?: number;
  /**
   * Composite fatigue score 0–100, attached by the UI layer after result()
   * (needs the personal baseline from IndexedDB). Absent on records saved
   * before step-2b — guard renders.
   */
  fatigueScore?: number;
}

/** Wilson–Hilferty Poisson 95% interval for a count. */
export function poissonInterval(n: number): { lower: number; upper: number } {
  const z = 1.96;
  const lower = n === 0 ? 0 : n * Math.pow(1 - 1 / (9 * n) - z / (3 * Math.sqrt(n)), 3);
  const upper = (n + 1) * Math.pow(1 - 1 / (9 * (n + 1)) + z / (3 * Math.sqrt(n + 1)), 3);
  return { lower, upper };
}

/** Aggregates frames into a QuickCheckResult. Pure and synchronous. */
export class QuickCheckAggregator {
  readonly detector = new BlinkDetector();
  readonly quality = new QualityCtx();
  /** Dev-mode trace of every processed frame (eyeContour stripped). */
  traceFrames: FrameFeatures[] = [];
  /** Dev-mode per-frame quality verdicts, aligned with traceFrames. */
  traceDiag: { ok: boolean; reasons: string[]; glare: boolean; backlit: boolean; fps: number }[] = [];
  traceEnabled = false;

  startedAt: string | null = null;
  private firstT: number | null = null;
  private lastT: number | null = null;
  private distances: number[] = [];
  private lumas: number[] = [];
  private squints: number[] = [];
  private jawSince: number | null = null;
  private yawnCount = 0;
  private glareFrames = 0;
  private backlitFrames = 0;
  private faceFrames = 0;

  begin(): void {
    this.startedAt = new Date().toISOString();
  }

  push(f: FrameFeatures): void {
    if (this.startedAt === null) this.begin();
    if (this.traceEnabled) this.traceFrames.push({ ...f, eyeContour: [] });
    if (this.firstT === null) this.firstT = f.t;
    this.lastT = f.t;

    const v = this.quality.check(f);
    if (this.traceEnabled) {
      this.traceDiag.push({
        ok: v.ok,
        reasons: v.reasons,
        glare: v.glare,
        backlit: v.backlit,
        fps: v.fps,
      });
    }
    if (f.face) {
      this.faceFrames++;
      if (v.glare) this.glareFrames++;
      if (v.backlit) this.backlitFrames++;
    }
    if (!v.ok) {
      this.jawSince = null;
      return;
    }
    this.detector.push(f);
    this.lumas.push(f.faceLuma);
    this.squints.push((f.squintL + f.squintR) / 2);
    if (f.irisPx > 0) this.distances.push(estimateDistanceCm(f.irisPx, f.frameW));

    if (f.jawOpen > 0.5) {
      if (this.jawSince === null) this.jawSince = f.t;
      else if (f.t - this.jawSince >= 1500) {
        this.yawnCount++;
        this.jawSince = null;
      }
    } else {
      this.jawSince = null;
    }
  }

  get fpsMean(): number {
    const s = this.quality.fpsSamples;
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  }

  result(source: 'camera' | 'file' | 'monitor' = 'camera'): QuickCheckResult {
    const d = this.detector;
    d.finish();
    const events = d.events;
    const complete = events.filter((e) => e.complete);
    const incomplete = events.filter((e) => !e.complete);
    const qualityMin = d.qualityMs / 60000;
    const ibis = d.interBlinkIntervals;
    const durationMs = this.firstT === null || this.lastT === null ? 0 : this.lastT - this.firstT;
    const qualityPct = durationMs > 0 ? (d.qualityMs / durationMs) * 100 : 0;
    const interval = poissonInterval(events.length);
    const glarePct = this.faceFrames > 0 ? (this.glareFrames / this.faceFrames) * 100 : 0;
    const backlitPct = this.faceFrames > 0 ? (this.backlitFrames / this.faceFrames) * 100 : 0;
    const fpsMean = this.fpsMean;

    const core = {
      blinkRate: qualityMin > 0 ? events.length / qualityMin : 0,
      blinkRateLow: qualityMin > 0 ? interval.lower / qualityMin : 0,
      blinkRateHigh: qualityMin > 0 ? interval.upper / qualityMin : 0,
      completeBlinks: complete.length,
      incompleteBlinks: incomplete.length,
      incompleteRatio: events.length > 0 ? incomplete.length / events.length : 0,
      meanBlinkMs: events.length ? events.reduce((s, e) => s + e.durationMs, 0) / events.length : 0,
      meanReopenFrac: mean(
        events
          .filter((e) => e.closeMs + e.reopenMs > 0)
          .map((e) => e.reopenMs / (e.closeMs + e.reopenMs)),
      ),
      longClosures: events.filter((e) => e.longClosure).length,
      perclos: d.perclos,
      maxIbiMs: ibis.length ? Math.max(...ibis) : 0,
      ibiOver10s: ibis.filter((g) => g > CFG.ibiWatchMs).length,
      distanceCm: median(this.distances),
      luma: median(this.lumas),
      squint: mean(this.squints),
      yawns: this.yawnCount,
      fpsMean,
      glarePct,
      backlitPct,
      gazeDownDiscards: d.gazeDownDiscards,
      asymmetricDiscards: d.asymmetricDiscards,
    };
    // distanceAvailable: only a video file lacks a live camera's iris metric.
    const { statuses, tips } = assess(core, events.length, source !== 'file');
    const { confidence, reasons } = assessConfidence({
      qualityMs: d.qualityMs,
      qualityPct,
      fpsMean,
      glarePct,
      backlitPct,
      discardPct: d.discardPct,
      candidateCount: d.candidateCount,
    });
    return {
      schemaVersion: 2,
      id: crypto.randomUUID(),
      startedAt: this.startedAt ?? new Date().toISOString(),
      durationMs,
      qualityMs: d.qualityMs,
      qualityPct,
      ...core,
      confidence,
      confidenceReasons: reasons,
      tips,
      statuses,
      source,
    };
  }
}

interface ConfidenceInput {
  qualityMs: number;
  qualityPct: number;
  fpsMean: number;
  glarePct: number;
  backlitPct: number;
  discardPct: number;
  candidateCount: number;
}

export function assessConfidence(i: ConfidenceInput): {
  confidence: Confidence;
  reasons: ConfidenceReason[];
} {
  const reasons: ConfidenceReason[] = [];
  if (i.qualityMs < CFG.confHighQualityMs) {
    reasons.push({
      text: `Only ${Math.round(i.qualityMs / 1000)} s of usable footage (${Math.round(CFG.confHighQualityMs / 1000)} s+ recommended)`,
      fix: 'Keep your face in frame and well lit for the whole check.',
    });
  }
  if (i.qualityPct < CFG.confHighQualityPct) {
    reasons.push({
      text: `${Math.round(i.qualityPct)}% of frames were usable (${CFG.confHighQualityPct}%+ recommended)`,
      fix: 'Hold still and face the camera so fewer frames are dropped.',
    });
  }
  if (i.fpsMean < CFG.confHighFps) {
    reasons.push({
      text: `Frame rate averaged ${i.fpsMean.toFixed(0)} fps (${CFG.confHighFps}+ recommended)`,
      fix: 'Add light, or close other apps using the camera/CPU.',
    });
  }
  if (i.glarePct > CFG.confHighGlarePct) {
    reasons.push({
      text: `Reflections on glasses in ${Math.round(i.glarePct)}% of frames`,
      fix: 'Tilt your glasses slightly or move the light source off to the side.',
    });
  }
  if (i.backlitPct > CFG.confHighBacklitPct) {
    reasons.push({
      text: `Strong backlight in ${Math.round(i.backlitPct)}% of frames`,
      fix: 'Face a window or lamp so the light falls on your face.',
    });
  }
  const discardAbstain =
    i.candidateCount >= CFG.maxDiscardMinCandidates && i.discardPct > CFG.maxDiscardPct;
  if (discardAbstain) {
    reasons.push({
      text: `${Math.round(i.discardPct)}% of ${i.candidateCount} blink candidates were discarded (gaze-down or one-sided closures)`,
      fix: 'Face the camera squarely and keep both eyes in view, then try again.',
    });
  } else if (i.discardPct > CFG.confHighDiscardPct) {
    reasons.push({
      text: `${Math.round(i.discardPct)}% of blink candidates were discarded`,
      fix: 'Look straight at the screen and keep both eyes visible.',
    });
  }
  if (reasons.length === 0) return { confidence: 'high', reasons };
  if (discardAbstain) return { confidence: 'low', reasons };

  const medium =
    i.qualityMs >= CFG.confMedQualityMs &&
    i.qualityPct >= CFG.confMedQualityPct &&
    i.fpsMean >= CFG.confMedFps;
  return { confidence: medium ? 'medium' : 'low', reasons };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
