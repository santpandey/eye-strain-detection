"""score_and_learn: attach the composite fatigue score to a fresh
(non-abstained) result and let the personal baseline learn from it.

Must run AFTER agg.result() and BEFORE save_session() so the stored record
carries `fatigueScore`. Order matters: the score is computed against the
baseline as it was before this check, then this session is folded in —
otherwise the session would drift the reference it is compared against.
Storage failures degrade to an unanchored score rather than blocking the
result.

Keep in sync with src/lib/analysis/scoreSession.ts — synchronous port.
"""

from __future__ import annotations

from .baseline import empty_baseline
from .fatigueScore import fatigue_score
from .storage import get_baseline, update_baseline


def score_and_learn(r: dict) -> dict:
    """Returns {"out": fatigue_score output, "baseline": pre-update snapshot,
    "sessionsSoFar": contributing sessions including this one}."""
    try:
        baseline = get_baseline()
    except Exception:
        baseline = empty_baseline()  # storage failure → population anchors
    out = fatigue_score(r, baseline)
    if out["score"] is not None:
        r["fatigueScore"] = out["score"]
    sessions_so_far = baseline["sessions"] + 1
    try:
        sessions_so_far = update_baseline(r, baseline)["sessions"]
    except Exception:
        pass  # baseline persistence failure → keep the optimistic count
    return {"out": out, "baseline": baseline, "sessionsSoFar": sessions_so_far}
