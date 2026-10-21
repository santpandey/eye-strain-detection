"""match_blinks: greedy time-ordered matching for accuracy eval.

Keep in sync with src/lib/analysis/eval.ts — this is a 1:1 port.
"""

from __future__ import annotations

from .config import CFG


def match_blinks(events, labels, quality_min: float, tol_ms: float = CFG.matchTolMs) -> dict:
    """A label at t matches an unmatched detected event if
    start − tol ≤ t ≤ end + tol.

    `events`: objects/dicts with .start/.end (or "start"/"end" keys).
    `labels`: list of numbers or {"t": …} dicts.
    """
    ts = sorted(l if isinstance(l, (int, float)) else l["t"] for l in labels)

    def _start(e):
        return e["start"] if isinstance(e, dict) else e.start

    def _end(e):
        return e["end"] if isinstance(e, dict) else e.end

    ev = sorted(events, key=_start)
    used: set = set()
    label_event: list = [None] * len(ts)
    unmatched_events: list = []
    tp = 0
    for e in ev:
        hit = False
        for i in range(len(ts)):
            if i in used:
                continue
            if ts[i] < _start(e) - tol_ms:
                continue
            if ts[i] > _end(e) + tol_ms:
                break
            used.add(i)
            label_event[i] = e
            hit = True
            tp += 1
            break
        if not hit:
            unmatched_events.append(e)
    fp = len(ev) - tp
    fn = len(ts) - tp
    precision = tp / (tp + fp) if tp + fp > 0 else 0.0
    recall = tp / (tp + fn) if tp + fn > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if precision + recall > 0 else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        # (detected/min − true/min), using the provided quality minutes.
        "rateErrorPerMin": (len(ev) - len(ts)) / quality_min if quality_min > 0 else 0.0,
        "detectedCount": len(ev),
        "trueCount": len(ts),
        # Every label (time-sorted) with the event it matched, or None (miss).
        "labelMatches": [{"t": t, "event": label_event[i]} for i, t in enumerate(ts)],
        # Detected events (start-sorted) that matched no label (false positives).
        "unmatchedEvents": unmatched_events,
    }
