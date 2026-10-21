import type { BlinkEvent } from './blink';
import { CFG } from './config';

export interface Label {
  t: number;
}

type Span = { start: number; end: number };

export interface MatchResult<E extends Span = Span> {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  /** (detected/min − true/min), using the provided quality minutes. */
  rateErrorPerMin: number;
  detectedCount: number;
  trueCount: number;
  /** Every label (time-sorted) with the event it matched, or null (miss). */
  labelMatches: { t: number; event: E | null }[];
  /** Detected events (start-sorted) that matched no label (false positives). */
  unmatchedEvents: E[];
}

/**
 * Greedy time-ordered matching: a label at t matches an unmatched detected
 * event if start − tol ≤ t ≤ end + tol.
 */
export function matchBlinks<E extends Span = BlinkEvent>(
  events: readonly E[],
  labels: readonly Label[] | readonly number[],
  qualityMin: number,
  tolMs: number = CFG.matchTolMs,
): MatchResult<E> {
  const ts = labels.map((l: Label | number) => (typeof l === 'number' ? l : l.t)).sort((a, b) => a - b);
  const ev = [...events].sort((a, b) => a.start - b.start);
  const used = new Set<number>();
  const labelEvent: (E | null)[] = ts.map(() => null);
  const unmatchedEvents: E[] = [];
  let tp = 0;
  for (const e of ev) {
    let hit = false;
    for (let i = 0; i < ts.length; i++) {
      if (used.has(i)) continue;
      if (ts[i] < e.start - tolMs) continue;
      if (ts[i] > e.end + tolMs) break;
      used.add(i);
      labelEvent[i] = e;
      hit = true;
      tp++;
      break;
    }
    if (!hit) unmatchedEvents.push(e);
  }
  const fp = ev.length - tp;
  const fn = ts.length - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    rateErrorPerMin: qualityMin > 0 ? (ev.length - ts.length) / qualityMin : 0,
    detectedCount: ev.length,
    trueCount: ts.length,
    labelMatches: ts.map((t, i) => ({ t, event: labelEvent[i] })),
    unmatchedEvents,
  };
}
