//! Guided eye-rest exercises offered by background-monitor reminders.
//! Pure data — reimplemented from the product summary (look-far 20 s,
//! full-blinks ~30 s, palming 30 s); matches cli/blinkwell/exercises.py.

#[derive(Debug, Clone, Copy)]
pub struct Exercise {
    pub id: &'static str,
    pub title: &'static str,
    pub seconds: u32,
    pub steps: &'static [&'static str],
}

pub const EXERCISES: [Exercise; 3] = [
    Exercise {
        id: "look-far",
        title: "20-20-20 break",
        seconds: 20,
        steps: &[
            "Look at something about 6 metres (20 feet) away — a window view is ideal.",
            "Let your focus relax and blink normally.",
        ],
    },
    Exercise {
        id: "full-blinks",
        title: "10 slow, full blinks",
        seconds: 30,
        steps: &[
            "Close your eyes fully, pause for a beat, then reopen.",
            "Repeat slowly — about 10 blinks, no rushing.",
        ],
    },
    Exercise {
        id: "palming",
        title: "Palming",
        seconds: 30,
        steps: &[
            "Rub your palms together to warm them.",
            "Cup them gently over your closed eyes — no pressure on the lids.",
            "Breathe slowly and let your eyes rest in the dark.",
        ],
    },
];

pub fn exercise(id: &str) -> Option<&'static Exercise> {
    EXERCISES.iter().find(|e| e.id == id)
}
