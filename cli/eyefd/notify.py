"""OS notifications for monitor reminders — best effort, never raises.

Tries plyer (win10toast / platform toast). Falls back to a console line.
"""

from __future__ import annotations


def send_notification(title: str, body: str) -> None:
    """Show an OS toast; on any failure print a [REMINDER] line instead."""
    try:
        from plyer import notification

        notification.notify(title=title, message=body, app_name="eyefd", timeout=10)
        return
    except Exception:
        pass
    try:
        print(f"[REMINDER] {title} — {body}", flush=True)
    except Exception:
        pass
