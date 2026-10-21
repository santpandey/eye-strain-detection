"""Status rules + the two-axis overall_verdict + tips + DISCLAIMER.

Keep in sync with src/lib/analysis/thresholds.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math
from decimal import Decimal, ROUND_HALF_UP

from .config import CFG

# Status = 'good' | 'watch' | 'high' | 'na'
METRICS = (
    "blinkRate",
    "incompleteRatio",
    "meanBlinkMs",
    "reopenFrac",
    "perclos",
    "maxIbiMs",
    "distanceCm",
    "luma",
)

# Metrics that actually indicate tired/drowsy eyes vs. metrics that mostly
# reflect the task context. Literature basis: reading/screen tasks suppress
# blink rate within ~1 min regardless of fatigue (Tayson 2023; Argiles 2015
# found incomplete-blink share, not rate, correlates with CVS symptoms), so a
# low blink rate means "screen focus → dry-eye risk", not tiredness. PERCLOS,
# blink duration and slow lid reopening are the validated drowsiness signals
# (Wierwille 1994; Schleicher 2008).
FATIGUE_METRICS = [
    "incompleteRatio",
    "meanBlinkMs",
    "reopenFrac",
    "perclos",
]
CONTEXT_METRICS = ["blinkRate", "maxIbiMs", "distanceCm", "luma"]


def overall_verdict(s: dict) -> str:
    """Headline verdict: fatigue signals outrank task-context signals."""
    fatigue = [s[m] for m in FATIGUE_METRICS if s[m] != "na"]
    context = [s[m] for m in CONTEXT_METRICS if s[m] != "na"]
    if "high" in fatigue:
        return "Your eyes look tired"
    if "watch" in fatigue:
        return "A few things to watch"
    if "high" in context or "watch" in context:
        return "Screen-focus strain signs"
    return "Looking good"


def _js_round(x: float) -> int:
    """Math.round — ties toward +∞ (not Python's banker's rounding)."""
    return math.floor(x + 0.5)


def _to_fixed0(x: float) -> str:
    """Number.prototype.toFixed(0) — ties pick the larger value."""
    return str(Decimal(repr(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def assess(c: dict, event_count: int, distance_available: bool = True) -> dict:
    statuses = {
        "blinkRate": (
            "high"
            if c["blinkRate"] < CFG.blinkRateHighLow or c["blinkRate"] > CFG.blinkRateHighHigh
            else (
                "watch"
                if c["blinkRate"] < CFG.blinkRateWatchLow
                or c["blinkRate"] > CFG.blinkRateWatchHigh
                else "good"
            )
        ),
        "incompleteRatio": (
            "na"
            if event_count < CFG.minEventsIncomplete
            else (
                "high"
                if c["incompleteRatio"] > CFG.incompleteHigh
                else ("watch" if c["incompleteRatio"] > CFG.incompleteWatch else "good")
            )
        ),
        "meanBlinkMs": (
            "na"
            if event_count < CFG.minEventsMeanBlink
            else (
                "high"
                if c["meanBlinkMs"] > CFG.meanBlinkHighMs
                else ("watch" if c["meanBlinkMs"] > CFG.meanBlinkWatchMs else "good")
            )
        ),
        "reopenFrac": (
            "na"
            if event_count < CFG.minEventsMeanBlink
            else (
                "high"
                if c["meanReopenFrac"] > CFG.reopenFracHigh
                else ("watch" if c["meanReopenFrac"] > CFG.reopenFracWatch else "good")
            )
        ),
        "perclos": (
            "high"
            if c["perclos"] > CFG.perclosHigh
            else ("watch" if c["perclos"] > CFG.perclosWatch else "good")
        ),
        "maxIbiMs": (
            "high"
            if c["maxIbiMs"] > CFG.ibiHighMs
            else ("watch" if c["maxIbiMs"] > CFG.ibiWatchMs else "good")
        ),
        "distanceCm": (
            "na"
            if not distance_available
            else (
                "high"
                if c["distanceCm"] > 0 and c["distanceCm"] < CFG.distanceHighCm
                else (
                    "watch"
                    if c["distanceCm"] > 0 and c["distanceCm"] < CFG.distanceWatchCm
                    else "good"
                )
            )
        ),
        "luma": "watch" if c["luma"] > 0 and c["luma"] < CFG.lumaWatch else "good",
    }
    return {"statuses": statuses, "tips": _tips_for(statuses, c, event_count)}


def _tips_for(s: dict, c: dict, event_count: int) -> list:
    tips: list = []
    if s["blinkRate"] != "good":
        tips.append(
            f"Your blink rate was low ({_to_fixed0(c['blinkRate'])}/min). Screen focus suppresses blinking — try 10 slow, full blinks now."
            if c["blinkRate"] < CFG.blinkRateWatchLow
            else f"Your blink rate was high ({_to_fixed0(c['blinkRate'])}/min). That can signal irritation or dryness — consider lubricating drops and a short break."
        )
    if s["incompleteRatio"] == "na":
        # silently skipped — not enough events
        pass
    elif s["incompleteRatio"] != "good":
        tips.append(
            "Many of your blinks were partial. Close your eyes fully for a second — that spreads the tear film properly."
        )
    if s["meanBlinkMs"] != "good" and s["meanBlinkMs"] != "na":
        tips.append(
            "Your blinks were slow and heavy — a classic sign of tired eyes. A short break would help."
        )
    if s["reopenFrac"] != "good" and s["reopenFrac"] != "na":
        tips.append(
            "Your eyelids were slow to reopen after blinking — a drowsiness sign. A real break beats forcing blinks."
        )
    if s["perclos"] != "good":
        tips.append(
            "Your eyes stayed closed or nearly closed for a notable share of the check. Time to rest them."
        )
    if s["maxIbiMs"] != "good":
        tips.append(
            f"You went {_js_round(c['maxIbiMs'] / 1000)}s without blinking at one point. Remind yourself to blink during focused work."
        )
    if s["distanceCm"] != "good" and s["distanceCm"] != "na":
        tips.append(
            f"You sat about {_js_round(c['distanceCm'])} cm from the screen. Aim for roughly 50–70 cm."
        )
    if s["luma"] != "good":
        tips.append(
            "The room looked dim. More ambient light (not glare on the screen) is easier on your eyes."
        )
    if event_count < CFG.minEventsMeanBlink:
        tips.append("Very few blinks were detected — treat the detailed metrics with care.")
    return tips


DISCLAIMER = "Wellness guidance, not a medical diagnosis."
