"""evaluate_reminders -> break/tired/blink reminders for the monitor.

Ported 1:1 from src/lib/analysis/monitorRules.ts — that file was removed when
the in-browser monitor was deleted; this module is now the canonical home of
the reminder rules.
"""

from __future__ import annotations

from .config import CFG


def evaluate_reminders(s: dict) -> list:
    """Which reminders the background monitor should surface right now.

    `s` is a dict (TS MonitorRuleState):
      now, monitorOnSince, lastBreakAt (None = none yet), lastWindowResult
      (None when the last window abstained or none ran), windowCount,
      breakEveryMs (optional override).

    At most one reminder per kind is ever returned by a single evaluation.
    """
    out: list = []
    break_every_ms = s.get("breakEveryMs")
    if break_every_ms is None:
        break_every_ms = CFG.monitorBreakEveryMs

    # 20-20-20: time since the last break (or since monitoring started).
    break_since = s["lastBreakAt"] if s["lastBreakAt"] is not None else s["monitorOnSince"]
    if s["now"] - break_since >= break_every_ms:
        out.append(
            {
                "id": f"break:{s['now']}",
                "kind": "break",
                "title": "Time for a 20-20-20 break",
                "body": "Every 20 minutes, look at something about 6 metres (20 feet) away for 20 seconds.",
                "exercise": "look-far",
            }
        )

    # One nudge from the latest window: a high fatigue score outranks
    # task-context signs (low blink rate / long gaps mean screen focus).
    r = s.get("lastWindowResult")
    if r:
        if r.get("fatigueScore") is not None and r["fatigueScore"] >= CFG.scoreHigh:
            out.append(
                {
                    "id": f"tired:{s['now']}",
                    "kind": "tired",
                    "title": "Your eyes look tired",
                    "body": "The last check showed strong tired-eye signs. A short rest beats pushing through.",
                    "exercise": "palming",
                }
            )
        elif r["statuses"]["blinkRate"] == "high" or r["statuses"]["maxIbiMs"] == "high":
            out.append(
                {
                    "id": f"blink:{s['now']}",
                    "kind": "blink",
                    "title": "Remember to blink",
                    "body": "Screen focus is suppressing your blinks — a few slow, full blinks spread the tear film.",
                    "exercise": "full-blinks",
                }
            )
    return out
