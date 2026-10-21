"""Guided eye-rest exercises offered by background-monitor reminders.
Pure data.

Keep in sync with src/lib/monitor/exercises.ts — this is a 1:1 port.
"""

EXERCISES = {
    "look-far": {
        "id": "look-far",
        "title": "20-20-20 break",
        "seconds": 20,
        "steps": [
            "Look at something about 6 metres (20 feet) away — a window view is ideal.",
            "Let your focus relax and blink normally.",
        ],
    },
    "full-blinks": {
        "id": "full-blinks",
        "title": "10 slow, full blinks",
        "seconds": 30,
        "steps": [
            "Close your eyes fully, pause for a beat, then reopen.",
            "Repeat slowly — about 10 blinks, no rushing.",
        ],
    },
    "palming": {
        "id": "palming",
        "title": "Palming",
        "seconds": 30,
        "steps": [
            "Rub your palms together to warm them.",
            "Cup them gently over your closed eyes — no pressure on the lids.",
            "Breathe slowly and let your eyes rest in the dark.",
        ],
    },
}
