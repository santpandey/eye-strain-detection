"""Composite fatigue score: one explainable 0–100 number built only from the
FATIGUE axis metrics — task-context metrics like blink rate are deliberately
excluded (screen focus suppresses them regardless of tiredness; see
thresholds.py for the literature note).

Each metric contributes a saturating sub-score r/(r+K) where r is the value
relative to a reference: the user's own baseline median when the baseline is
ready, else the population 'watch' threshold (marked `estimated`). Score is
100 × the weight-renormalised mean of the available sub-scores, and None when
the session is too weak to judge (low confidence or very few blinks).

Keep in sync with src/lib/analysis/fatigueScore.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math

from .baseline import baseline_median, baseline_ready, usual_delta_pct
from .config import CFG

_SPECS = [
    {
        "metric": "perclos",
        "baselineKey": "perclos",
        "statusKey": "perclos",
        "label": "eye closure",
        "popRef": CFG.perclosWatch,
    },
    {
        "metric": "meanBlinkMs",
        "baselineKey": "meanBlinkMs",
        "statusKey": "meanBlinkMs",
        "label": "blink length",
        "popRef": CFG.meanBlinkWatchMs,
    },
    {
        "metric": "meanReopenFrac",
        "baselineKey": "meanReopenFrac",
        "statusKey": "reopenFrac",
        "label": "lid reopening",
        "popRef": CFG.reopenFracWatch,
    },
    {
        "metric": "incompleteRatio",
        "baselineKey": "incompleteRatio",
        "statusKey": "incompleteRatio",
        "label": "partial blinks",
        "popRef": CFG.incompleteWatch,
    },
]


def fatigue_score(r: dict, baseline: dict | None) -> dict:
    """Returns {"score": int|None, "parts": [...], "baselineReady": bool}."""
    ready = baseline_ready(baseline)
    parts: list = []
    for spec in _SPECS:
        if r.get("statuses", {}).get(spec["statusKey"]) == "na":
            continue
        v = r.get(spec["metric"])
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            continue
        med = baseline_median(baseline, spec["baselineKey"]) if ready else None
        estimated = not (med is not None and med > 0)
        ref = spec["popRef"] if estimated else med
        ratio = v / ref if ref > 0 else 0.0
        sub = ratio / (ratio + CFG.scoreSaturateK)
        weight = CFG.scoreWeights[spec["metric"]]
        parts.append(
            {
                "metric": spec["metric"],
                "label": spec["label"],
                "weight": weight,
                "sub": sub,
                "contribution": weight * sub,
                "deltaPct": usual_delta_pct(v, med),
                "estimated": estimated,
            }
        )

    events = r.get("completeBlinks", 0) + r.get("incompleteBlinks", 0)
    too_weak = r.get("confidence") == "low" or events < CFG.scoreMinEvents
    w_sum = sum(p["weight"] for p in parts)
    score = (
        None
        if too_weak or w_sum <= 0
        else math.floor(100 * (sum(p["contribution"] for p in parts) / w_sum) + 0.5)
    )
    return {"score": score, "parts": parts, "baselineReady": ready}


def score_tier(score: float) -> str:
    """Chip tier for a score: good < scoreWatch ≤ watch < scoreHigh ≤ high."""
    if score >= CFG.scoreHigh:
        return "high"
    if score >= CFG.scoreWatch:
        return "watch"
    return "good"
