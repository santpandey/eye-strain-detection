import { getBaseline, updateBaseline } from '../storage/db';
import { emptyBaseline, type BaselineStats } from './baseline';
import { fatigueScore, type FatigueScoreOut } from './fatigueScore';
import type { QuickCheckResult } from './session';

/**
 * UI-layer orchestration shared by the camera and file flows: attach the
 * composite fatigue score to a fresh (non-abstained) result and let the
 * personal baseline learn from it. Must run AFTER agg.result() and BEFORE
 * saveSession() so the stored record carries `fatigueScore`.
 *
 * Order matters: the score is computed against the baseline as it was before
 * this check, then this session is folded in — otherwise the session would
 * drift the reference it is compared against. Storage failures degrade to
 * an unanchored score rather than blocking the results view.
 */
export interface ScoreView {
  /** fatigueScore() output: score, explainable parts, baselineReady. */
  out: FatigueScoreOut;
  /** The baseline the score was compared against (pre-update snapshot). */
  baseline: BaselineStats;
  /** Contributing sessions including this one (for "N of 3" / footnotes). */
  sessionsSoFar: number;
}

export async function scoreAndLearn(r: QuickCheckResult): Promise<ScoreView> {
  let baseline = emptyBaseline();
  try {
    baseline = await getBaseline();
  } catch {
    // Storage failure → score against population anchors.
  }
  const out = fatigueScore(r, baseline);
  if (out.score !== null) r.fatigueScore = out.score;
  let sessionsSoFar = baseline.sessions + 1;
  try {
    sessionsSoFar = (await updateBaseline(r, baseline)).sessions;
  } catch {
    // Baseline persistence failure → keep the optimistic count.
  }
  return { out, baseline, sessionsSoFar };
}
