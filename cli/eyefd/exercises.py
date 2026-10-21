"""Guided eye-rest exercises offered by monitor reminders. Pure data.

Ported 1:1 from src/lib/monitor/exercises.ts — removed with the in-browser
monitor; this module is now the canonical home of the exercise data.
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
