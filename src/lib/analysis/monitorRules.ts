import { CFG } from './config';
import type { QuickCheckResult } from './session';
import type { ExerciseId } from '../monitor/exercises';

export type ReminderKind = 'break' | 'tired' | 'blink';

export interface Reminder {
  /** Unique per firing; `kind` + the evaluation `now` so tests stay deterministic. */
  id: string;
  kind: ReminderKind;
  title: string;
  body: string;
  /** Guided exercise offered by the reminder card, if any. */
  exercise?: ExerciseId;
}

export interface MonitorRuleState {
  /** Date.now() of this evaluation. */
  now: number;
  /** When the monitor was switched on (fallback anchor for the break timer). */
  monitorOnSince: number;
  /** Last completed break/exercise; null = none yet. */
  lastBreakAt: number | null;
  /** Most recent SAVED window result; null when the last window abstained or none ran. */
  lastWindowResult: QuickCheckResult | null;
  /** Windows completed since the monitor was switched on. */
  windowCount: number;
  /** Break interval override (dev `eyefd.monitorCfg`); defaults to CFG. */
  breakEveryMs?: number;
}

/**
 * Which reminders the background monitor should surface right now.
 * Pure — dedupe/snooze/notification live in monitorSession; at most one
 * reminder per kind is ever returned by a single evaluation.
 */
export function evaluateReminders(s: MonitorRuleState): Reminder[] {
  const out: Reminder[] = [];
  const breakEveryMs = s.breakEveryMs ?? CFG.monitorBreakEveryMs;

  // 20-20-20: time since the last break (or since monitoring started).
  const breakSince = s.lastBreakAt ?? s.monitorOnSince;
  if (s.now - breakSince >= breakEveryMs) {
    out.push({
      id: `break:${s.now}`,
      kind: 'break',
      title: 'Time for a 20-20-20 break',
      body: 'Every 20 minutes, look at something about 6 metres (20 feet) away for 20 seconds.',
      exercise: 'look-far',
    });
  }

  // One nudge from the latest window: a high fatigue score outranks
  // task-context signs (low blink rate / long gaps mean screen focus).
  const r = s.lastWindowResult;
  if (r) {
    if (r.fatigueScore != null && r.fatigueScore >= CFG.scoreHigh) {
      out.push({
        id: `tired:${s.now}`,
        kind: 'tired',
        title: 'Your eyes look tired',
        body: 'The last check showed strong tired-eye signs. A short rest beats pushing through.',
        exercise: 'palming',
      });
    } else if (r.statuses.blinkRate === 'high' || r.statuses.maxIbiMs === 'high') {
      out.push({
        id: `blink:${s.now}`,
        kind: 'blink',
        title: 'Remember to blink',
        body: 'Screen focus is suppressing your blinks — a few slow, full blinks spread the tear film.',
        exercise: 'full-blinks',
      });
    }
  }
  return out;
}
