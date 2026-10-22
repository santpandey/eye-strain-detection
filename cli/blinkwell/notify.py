"""OS notifications for monitor reminders — best effort, never raises.

Tries plyer (win10toast / platform toast). Falls back to a console line.
"""

from __future__ import annotations

import os
import sys


def send_notification(title: str, body: str) -> None:
    """Show an OS toast; on any failure print a [REMINDER] line instead.

    OS-level toast paths can hard-crash a long-running monitor (a C-level
    fault isn't catchable), so Windows toasts stay opt-in via
    BLINKWELL_TOAST=1 — same contract as the Rust CLI. The caller already
    prints the reminder block; [REMINDER] goes to stderr so `monitor --json`
    stdout stays clean.
    """
    enabled = sys.platform != "win32" or os.environ.get("BLINKWELL_TOAST") == "1"
    if enabled:
        try:
            from plyer import notification

            notification.notify(title=title, message=body, app_name="blinkwell", timeout=10)
            return
        except Exception:
            pass
        try:
            print(f"[REMINDER] {title} — {body}", file=sys.stderr, flush=True)
        except Exception:
            pass
