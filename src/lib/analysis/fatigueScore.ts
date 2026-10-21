import { CFG } from './config';
import { baselineMedian, baselineReady, usualDeltaPct, type BaselineMetric, type BaselineStats } from './baseline';
import type { QuickCheckResult } from './session';
import type { Metric } from './thresholds';

/**
 * Composite fatigue score (step-2b phase 1): one explainable 0–100 number
 * built only from the FATIGUE axis metrics — task-context metrics like blink
 * rate are deliberately excluded (screen focus suppresses them regardless of
 * tiredness; see thresholds.ts for the literature note).
 *
 * Each metric contributes a saturating sub-score r/(r+K) where r is the value
 * relative to a reference: the user's own baseline median when the baseline is
 * ready, else the population 'watch' threshold (marked `estimated`). Score is
 * 100 × the weight-renormalised mean of the available sub-scores, and null
 * when the session is too weak to judge (low confidence or very few blinks).
 *
 * Pure — no DOM, no storage. Call sites handle IndexedDB.
 */

export interface ScorePart {
  /** QuickCheckResult field name, e.g. 'meanBlinkMs'. */
  metric: FatigueScoreMetric;
  /** Short label for UI delta/explain lines, e.g. 'blink length'. */
  label: string;
  /** Config weight (already re-normalisation aware via score formula). */
  weight: number;
  /** Normalised 0–1 sub-score (higher = more tired). */
  sub: number;
  /** weight × sub — this metric's share of the score. */
  contribution: number;
  /** % difference vs the personal baseline median; null when not comparable. */
  deltaPct: number | null;
  /** True when anchored to population thresholds instead of the baseline. */
  estimated: boolean;
}

export type FatigueScoreMetric = 'perclos' | 'meanBlinkMs' | 'meanReopenFrac' | 'incompleteRatio';

export interface FatigueScoreOut {
  /** 0–100, or null when the session is too weak to score. */
  score: number | null;
  parts: ScorePart[];
  /** Whether the score was personally anchored (baseline had ≥ min sessions). */
  baselineReady: boolean;
}

interface MetricSpec {
  metric: FatigueScoreMetric;
  /** BaselineStats.samples key (same name — kept explicit for clarity). */
  baselineKey: BaselineMetric;
  /** statuses key that can mark this metric 'na'. */
  statusKey: Metric;
  label: string;
  /** Population reference when no baseline: the 'watch' threshold. */
  popRef: number;
}

const SPECS: MetricSpec[] = [
  {
    metric: 'perclos',
    baselineKey: 'perclos',
    statusKey: 'perclos',
    label: 'eye closure',
    popRef: CFG.perclosWatch,
  },
  {
    metric: 'meanBlinkMs',
    baselineKey: 'meanBlinkMs',
    statusKey: 'meanBlinkMs',
    label: 'blink length',
    popRef: CFG.meanBlinkWatchMs,
  },
  {
    metric: 'meanReopenFrac',
    baselineKey: 'meanReopenFrac',
    statusKey: 'reopenFrac',
    label: 'lid reopening',
    popRef: CFG.reopenFracWatch,
  },
  {
    metric: 'incompleteRatio',
    baselineKey: 'incompleteRatio',
    statusKey: 'incompleteRatio',
    label: 'partial blinks',
    popRef: CFG.incompleteWatch,
  },
];

export function fatigueScore(
  r: QuickCheckResult,
  baseline: BaselineStats | null | undefined,
): FatigueScoreOut {
  const ready = baselineReady(baseline);
  const parts: ScorePart[] = [];
  for (const spec of SPECS) {
    if (r.statuses?.[spec.statusKey] === 'na') continue;
    const v = r[spec.metric];
    if (!Number.isFinite(v)) continue;
    const med = ready ? baselineMedian(baseline, spec.baselineKey) : null;
    const estimated = !(med !== null && med > 0);
    const ref = estimated ? spec.popRef : med!;
    const ratio = ref > 0 ? v / ref : 0;
    const sub = ratio / (ratio + CFG.scoreSaturateK);
    const weight = CFG.scoreWeights[spec.metric];
    parts.push({
      metric: spec.metric,
      label: spec.label,
      weight,
      sub,
      contribution: weight * sub,
      deltaPct: usualDeltaPct(v, med),
      estimated,
    });
  }

  const events = r.completeBlinks + r.incompleteBlinks;
  const tooWeak = r.confidence === 'low' || events < CFG.scoreMinEvents;
  const wSum = parts.reduce((s, p) => s + p.weight, 0);
  const score =
    tooWeak || wSum <= 0
      ? null
      : Math.round(100 * (parts.reduce((s, p) => s + p.contribution, 0) / wSum));
  return { score, parts, baselineReady: ready };
}

/** Chip tier for a score: good < scoreWatch ≤ watch < scoreHigh ≤ high. */
export function scoreTier(score: number): 'good' | 'watch' | 'high' {
  if (score >= CFG.scoreHigh) return 'high';
  if (score >= CFG.scoreWatch) return 'watch';
  return 'good';
}
