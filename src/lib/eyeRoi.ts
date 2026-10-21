import type { FrameFeatures } from './vision/types';

/**
 * Eye-region clip for preview surfaces: a CSS clip-path inset (%) around the
 * two eye centres — eyes plus a small brow/cheek margin, nothing else. The
 * face mesh is still computed internally (the model needs it), but the only
 * image region the user ever sees or that is "captured" on screen is this.
 *
 * Returns null when no reliable ROI exists (caller keeps the last value).
 */
export function eyeRoiInset(f: FrameFeatures): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} | null {
  if (!f.face || !f.interocularPx || !f.frameW || !f.frameH) return null;
  const cx = (f.eyeCenters[0][0] + f.eyeCenters[1][0]) / 2;
  const cy = (f.eyeCenters[0][1] + f.eyeCenters[1][1]) / 2;
  if (![cx, cy].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  const w = (f.interocularPx / f.frameW) * 1.7; // half-width, normalised
  const h = (f.interocularPx / f.frameH) * 1.15; // half-height, normalised
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return {
    top: clamp((cy - h) * 100),
    right: clamp((1 - cx - w) * 100),
    bottom: clamp((1 - cy - h) * 100),
    left: clamp((cx - w) * 100),
  };
}

/** Smooth exponential tracker so the crop doesn't jitter frame to frame. */
export class RoiTracker {
  private cur: { top: number; right: number; bottom: number; left: number } | null = null;
  push(f: FrameFeatures): void {
    const next = eyeRoiInset(f);
    if (!next) return;
    const a = 0.35; // ~3-frame lag
    this.cur = this.cur
      ? {
          top: this.cur.top + (next.top - this.cur.top) * a,
          right: this.cur.right + (next.right - this.cur.right) * a,
          bottom: this.cur.bottom + (next.bottom - this.cur.bottom) * a,
          left: this.cur.left + (next.left - this.cur.left) * a,
        }
      : next;
  }
  /** clip-path CSS, or '' when nothing is tracked yet. */
  get css(): string {
    if (!this.cur) return '';
    const r = (v: number) => Math.min(45, Math.max(0, Math.round(v)));
    return `clip-path: inset(${r(this.cur.top)}% ${r(this.cur.right)}% ${r(this.cur.bottom)}% ${r(this.cur.left)}%)`;
  }
}
