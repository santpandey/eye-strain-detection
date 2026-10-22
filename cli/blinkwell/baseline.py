"""Personal baseline: robust central estimate of each tracked metric, learned
only from saved (non-abstained) checks on this device. Per-metric sliding
reservoir of the last `CFG.baselineReservoir` session values + median.

BaselineStats is a plain dict: {"version": 1, "sessions": int,
"samples": {metric: [float, …]}}.

Keep in sync with src/lib/analysis/baseline.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math

from .config import CFG

# Metrics the baseline tracks: the fatigue axis + blinkRate (context delta line).
BASELINE_METRICS = [
    "blinkRate",
    "meanBlinkMs",
    "meanReopenFrac",
    "perclos",
    "incompleteRatio",
]


def empty_baseline() -> dict:
    return {
        "version": 1,
        "sessions": 0,
        "samples": {
            "blinkRate": [],
            "meanBlinkMs": [],
            "meanReopenFrac": [],
            "perclos": [],
            "incompleteRatio": [],
        },
    }


def normalize_baseline(raw) -> dict:
    """Defensive normalization of whatever came back out of storage."""
    b = empty_baseline()
    if not isinstance(raw, dict):
        return b
    sessions = raw.get("sessions")
    b["sessions"] = math.floor(sessions) if isinstance(sessions, (int, float)) and math.isfinite(sessions) and sessions >= 0 else 0
    s = raw.get("samples")
    if isinstance(s, dict):
        for m in BASELINE_METRICS:
            arr = s.get(m)
            if isinstance(arr, list):
                b["samples"][m] = [
                    float(v) for v in arr if isinstance(v, (int, float)) and math.isfinite(v)
                ][-CFG.baselineReservoir :]
    return b


def baseline_ready(b: dict | None) -> bool:
    """baselineReady = enough contributing sessions (CFG.baselineMinSessions)."""
    return (b.get("sessions", 0) if b else 0) >= CFG.baselineMinSessions


def baseline_median(b: dict | None, metric: str):
    """Robust central estimate; None when the metric has no samples."""
    xs = (b or {}).get("samples", {}).get(metric)
    if not xs:
        return None
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def usual_delta_pct(value: float, median):
    """Signed % difference of `value` vs a baseline median; None when not comparable."""
    if median is None or not math.isfinite(median) or not math.isfinite(value):
        return None
    if median == 0:
        return 0.0 if value == 0 else None
    return ((value - median) / median) * 100


def delta_text(pct: float) -> str:
    """Short signed label for a deltaPct, e.g. '−38%', '+12%', '>10×' for extremes."""
    if not math.isfinite(pct):
        return "—"
    if pct >= 1000:
        return ">10×"
    if pct <= -100:
        return "−100%"
    rounded = _js_round(pct)
    if rounded < 0:
        return f"−{abs(rounded)}%"
    return f"+{rounded}%" if rounded > 0 else "0%"


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


# Which status entry (if any) can mark a baseline metric 'na' for a session.
_STATUS_KEY = {
    "blinkRate": None,  # always measured when there is usable footage
    "meanBlinkMs": "meanBlinkMs",
    "meanReopenFrac": "reopenFrac",
    "perclos": None,  # perclos is never 'na' — 0 is a real measurement
    "incompleteRatio": "incompleteRatio",
}


def contribute(b: dict, r: dict) -> dict:
    """Fold one saved session into the baseline (returns a new record). Call only
    for sessions that were actually saved — never abstained (low-confidence)
    ones. A metric's value is skipped when the session couldn't measure it
    (status 'na'), it isn't finite, or there was no usable footage at all.
    Non-camera sessions (file replays, traces) are dev data, not physiology —
    they must never shift the user's personal baseline."""
    if r.get("source") not in ("camera", "monitor"):
        return dict(b)
    nxt = {
        "version": 1,
        "sessions": b["sessions"] + 1,
        "samples": dict(b["samples"]),
    }
    cap = CFG.baselineReservoir
    for m in BASELINE_METRICS:
        status_key = _STATUS_KEY[m]
        if status_key and r.get("statuses", {}).get(status_key) == "na":
            continue
        v = r.get(m)
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            continue
        if m == "blinkRate" and r.get("qualityMs", 0) <= 0:
            continue
        nxt["samples"][m] = (list(nxt["samples"].get(m) or []) + [v])[-cap:]
    return nxt
