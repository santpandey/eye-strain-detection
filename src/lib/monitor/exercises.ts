/**
 * Guided eye-rest exercises offered by background-monitor reminders.
 * Pure data — the widget renders title/steps and the session runs the timer.
 */
export type ExerciseId = 'look-far' | 'full-blinks' | 'palming';

export interface Exercise {
  id: ExerciseId;
  title: string;
  /** Total guided duration; steps get an equal share each. */
  seconds: number;
  steps: string[];
}

export const EXERCISES: Record<ExerciseId, Exercise> = {
  'look-far': {
    id: 'look-far',
    title: '20-20-20 break',
    seconds: 20,
    steps: [
      'Look at something about 6 metres (20 feet) away — a window view is ideal.',
      'Let your focus relax and blink normally.',
    ],
  },
  'full-blinks': {
    id: 'full-blinks',
    title: '10 slow, full blinks',
    seconds: 30,
    steps: [
      'Close your eyes fully, pause for a beat, then reopen.',
      'Repeat slowly — about 10 blinks, no rushing.',
    ],
  },
  palming: {
    id: 'palming',
    title: 'Palming',
    seconds: 30,
    steps: [
      'Rub your palms together to warm them.',
      'Cup them gently over your closed eyes — no pressure on the lids.',
      'Breathe slowly and let your eyes rest in the dark.',
    ],
  },
};
