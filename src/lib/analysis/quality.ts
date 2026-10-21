import type { FrameFeatures } from '../vision/types';
import { CFG } from './config';

export type Reason = 'noFace' | 'headPose' | 'dark' | 'lowFps' | 'motion';

export interface QualityVerdict {
  ok: boolean;
  reasons: Reason[];
  /** Non-gating signals, for guidance + confidence. */
  glare: boolean;
  backlit: boolean;
  fps: number;
}

/**
 * Stateful quality gate. Tracks the processed-frame timestamps for rolling
 * fps (on the frame's own `t` timeline, so file sources work) and the previous
 * nose position for motion.
 */
export class QualityCtx {
  private ts: number[] = [];
  private prevNose: [number, number] | null = null;
  private prevT: number | null = null;
  private firstT: number | null = null;
  fpsSamples: number[] = [];
  /** Verdict of the most recent check. */
  last: QualityVerdict | null = null;

  check(f: FrameFeatures): QualityVerdict {
    // Rolling processed fps over the last window. Judged once the window
    // holds lowFpsMinFrames frames OR covers lowFpsMinSpanMs, whichever comes
    // first — so very slow streams (a few fps) are still caught.
    if (this.firstT === null) this.firstT = f.t;
    this.ts.push(f.t);
    const cutoff = f.t - CFG.lowFpsWindowMs;
    while (this.ts.length && this.ts[0] < cutoff) this.ts.shift();
    const n = this.ts.length;
    const spanMs = n > 1 ? this.ts[n - 1] - this.ts[0] : 0;
    // Time covered by the window (≥ frame span; also counts a lone frame).
    const windowMs = Math.min(CFG.lowFpsWindowMs, f.t - this.firstT);
    const judged = n >= CFG.lowFpsMinFrames || Math.max(spanMs, windowMs) >= CFG.lowFpsMinSpanMs;
    let fps: number;
    if (n >= 2 && spanMs > 0) fps = ((n - 1) * 1000) / spanMs;
    else fps = judged && windowMs > 0 ? (n * 1000) / windowMs : 0;
    if (judged) this.fpsSamples.push(fps);

    const reasons: Reason[] = [];
    if (!f.face) reasons.push('noFace');
    else {
      if (Math.abs(f.yaw) > CFG.headPoseDeg || Math.abs(f.pitch) > CFG.headPoseDeg) {
        reasons.push('headPose');
      }
      if (f.faceLuma < CFG.faceLumaMin) reasons.push('dark');
      // Motion: nose speed in interocular-widths per second.
      if (this.prevNose && this.prevT !== null && f.interocularPx > 0) {
        const dt = (f.t - this.prevT) / 1000;
        if (dt > 0) {
          const iow = f.interocularPx / f.frameW;
          const speed = Math.hypot(f.nose[0] - this.prevNose[0], f.nose[1] - this.prevNose[1]) / iow / dt;
          if (speed > CFG.motionMaxIowPerSec) reasons.push('motion');
        }
      }
      this.prevNose = f.nose;
      this.prevT = f.t;
    }
    if (judged && fps < CFG.lowFpsMin) {
      reasons.push('lowFps');
    }

    this.last = {
      ok: reasons.length === 0,
      reasons,
      glare: Math.max(f.glare[0], f.glare[1]) > CFG.glareFrac,
      backlit: f.face && f.frameLuma - f.faceLuma > CFG.backlitDelta,
      fps,
    };
    return this.last;
  }
}

/** Guidance lines in priority order for the align phase / capture pause. */
export function guidanceFor(v: QualityVerdict | null, fallback: string): string {
  if (!v) return 'Looking for your face…';
  if (v.reasons.includes('noFace')) return 'Looking for your face…';
  if (v.reasons.includes('headPose')) return 'Face the screen';
  if (v.reasons.includes('dark')) return 'More light on your face needed';
  if (v.backlit) return 'Light is behind you — face a window or lamp';
  if (v.reasons.includes('lowFps')) return 'Camera is too slow — add light or close other apps';
  if (v.reasons.includes('motion')) return 'Hold still';
  return fallback;
}
