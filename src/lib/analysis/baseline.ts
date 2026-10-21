import { CFG } from './config';
import type { QuickCheckResult } from './session';
import type { Metric } from './thresholds';

/**
 * Personal baseline (step-2b phase 1). A robust central estimate of each
 * tracked metric, learned only from saved (non-abstained) checks on this
 * device. Kept simple on purpose: a per-metric sliding reservoir of the last
 * `CFG.baselineReservoir` session values + median — no weighted schemes yet.
 *
 * Pure functions — persistence lives in storage/db.ts.
 */

/** Metrics the baseline tracks: the fatigue axis + blinkRate (context delta line). */
export type BaselineMetric =
  | 'meanBlinkMs'
  | 'meanReopenFrac'
  | 'perclos'
  | 'incompleteRatio'
  | 'blinkRate';

export const BASELINE_METRICS: readonly BaselineMetric[] = [
  'blinkRate',
  'meanBlinkMs',
  'meanReopenFrac',
  'perclos',
  'incompleteRatio',
];

export interface BaselineStats {
  version: 1;
  /** Number of saved sessions that have contributed. */
  sessions: number;
  /** Per-metric reservoirs of session values, oldest → newest. */
  samples: Record<BaselineMetric, number[]>;
}

export function emptyBaseline(): BaselineStats {
  return {
    version: 1,
    sessions: 0,
    samples: { blinkRate: [], meanBlinkMs: [], meanReopenFrac: [], perclos: [], incompleteRatio: [] },
  };
}

/** Defensive normalization of whatever came back out of IndexedDB. */
export function normalizeBaseline(raw: unknown): BaselineStats {
  const b = emptyBaseline();
  if (!raw || typeof raw !== 'object') return b;
  const r = raw as Partial<BaselineStats>;
  b.sessions = typeof r.sessions === 'number' && r.sessions >= 0 ? Math.floor(r.sessions) : 0;
  const s = r.samples;
  if (s && typeof s === 'object') {
    for (const m of BASELINE_METRICS) {
      const arr = (s as Record<string, unknown>)[m];
      if (Array.isArray(arr)) {
        b.samples[m] = arr.filter((v): v is number => Number.isFinite(v)).slice(-CFG.baselineReservoir);
      }
    }
  }
  return b;
}

/** baselineReady = enough contributing sessions (CFG.baselineMinSessions). */
export function baselineReady(b: BaselineStats | null | undefined): boolean {
  return (b?.sessions ?? 0) >= CFG.baselineMinSessions;
}

/** Robust central estimate; null when the metric has no samples. */
export function baselineMedian(
  b: BaselineStats | null | undefined,
  metric: BaselineMetric,
): number | null {
  const xs = b?.samples?.[metric];
  if (!xs || xs.length === 0) return null;
  const s = [...xs].sort((a, c) => a - c);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Signed % difference of `value` vs a baseline median; null when not comparable. */
export function usualDeltaPct(value: number, median: number | null): number | null {
  if (median === null || !Number.isFinite(median) || !Number.isFinite(value)) return null;
  if (median === 0) return value === 0 ? 0 : null;
  return ((value - median) / median) * 100;
}

/** Short signed label for a deltaPct, e.g. '−38%', '+12%', '>10×' for extremes. */
export function deltaText(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  if (pct >= 1000) return '>10×';
  if (pct <= -100) return '−100%';
  const rounded = Math.round(pct);
  return `${rounded > 0 ? '+' : ''}${rounded < 0 ? '−' + Math.abs(rounded) : rounded}%`;
}

/** Which status entry (if any) can mark a baseline metric 'na' for a session. */
const STATUS_KEY: Record<BaselineMetric, Metric | null> = {
  blinkRate: null, // always measured when there is usable footage
  meanBlinkMs: 'meanBlinkMs',
  meanReopenFrac: 'reopenFrac',
  perclos: null, // perclos is never 'na' — 0 is a real measurement
  incompleteRatio: 'incompleteRatio',
};

/**
 * Fold one saved session into the baseline (returns a new record). Call only
 * for sessions that were actually saved — never abstained (low-confidence)
 * ones. A metric's value is skipped when the session couldn't measure it
 * (status 'na'), it isn't finite, or there was no usable footage at all.
 */
export function contribute(b: BaselineStats, r: QuickCheckResult): BaselineStats {
  const next: BaselineStats = {
    version: 1,
    sessions: b.sessions + 1,
    samples: { ...b.samples },
  };
  const cap = CFG.baselineReservoir;
  for (const m of BASELINE_METRICS) {
    const statusKey = STATUS_KEY[m];
    if (statusKey && r.statuses?.[statusKey] === 'na') continue;
    const v = r[m];
    if (!Number.isFinite(v)) continue;
    if (m === 'blinkRate' && r.qualityMs <= 0) continue;
    next.samples[m] = [...(next.samples[m] ?? []), v].slice(-cap);
  }
  return next;
}
