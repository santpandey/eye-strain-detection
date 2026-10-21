import { describe, expect, it } from 'vitest';
import { evaluateReminders, type MonitorRuleState } from '../src/lib/analysis/monitorRules';
import { CFG } from '../src/lib/analysis/config';
import { makeResult } from './helpers';

const T0 = 1_000_000;

function state(over: Partial<MonitorRuleState> = {}): MonitorRuleState {
  return {
    now: T0,
    monitorOnSince: T0, // monitoring just started → no break due by default
    lastBreakAt: null,
    lastWindowResult: null,
    windowCount: 0,
    ...over,
  };
}

describe('evaluateReminders — break (20-20-20)', () => {
  it('does not fire before the break interval', () => {
    const s = state({ monitorOnSince: T0 - CFG.monitorBreakEveryMs + 1 });
    expect(evaluateReminders(s)).toEqual([]);
  });

  it('fires once the interval since monitor start elapses', () => {
    const s = state({ monitorOnSince: T0 - CFG.monitorBreakEveryMs });
    const rs = evaluateReminders(s);
    expect(rs).toHaveLength(1);
    expect(rs[0].kind).toBe('break');
    expect(rs[0].exercise).toBe('look-far');
  });

  it('counts from lastBreakAt when a break was taken', () => {
    const s = state({
      monitorOnSince: T0 - 10 * CFG.monitorBreakEveryMs,
      lastBreakAt: T0 - 1000, // recent break → not due
    });
    expect(evaluateReminders(s)).toEqual([]);
  });

  it('fires again once lastBreakAt ages past the interval', () => {
    const s = state({
      monitorOnSince: T0 - 10 * CFG.monitorBreakEveryMs,
      lastBreakAt: T0 - CFG.monitorBreakEveryMs - 1,
    });
    expect(evaluateReminders(s).map((r) => r.kind)).toEqual(['break']);
  });

  it('honours the breakEveryMs override (dev monitorCfg)', () => {
    const s = state({ monitorOnSince: T0 - 5000, breakEveryMs: 4000 });
    expect(evaluateReminders(s).map((r) => r.kind)).toEqual(['break']);
  });
});

describe('evaluateReminders — window-result rules', () => {
  it('high fatigue score → tired reminder with palming', () => {
    const s = state({ lastWindowResult: makeResult({ fatigueScore: CFG.scoreHigh }) });
    const rs = evaluateReminders(s);
    expect(rs).toHaveLength(1);
    expect(rs[0].kind).toBe('tired');
    expect(rs[0].exercise).toBe('palming');
  });

  it('score below the high threshold → no tired reminder', () => {
    const s = state({ lastWindowResult: makeResult({ fatigueScore: CFG.scoreHigh - 1 }) });
    expect(evaluateReminders(s)).toEqual([]);
  });

  it('missing score (unscored window) → no tired reminder', () => {
    const s = state({ lastWindowResult: makeResult({ fatigueScore: undefined }) });
    expect(evaluateReminders(s)).toEqual([]);
  });

  it('high blink-rate status → blink reminder with full-blinks', () => {
    const r = makeResult();
    r.statuses.blinkRate = 'high';
    const rs = evaluateReminders(state({ lastWindowResult: r }));
    expect(rs.map((x) => x.kind)).toEqual(['blink']);
    expect(rs[0].exercise).toBe('full-blinks');
  });

  it('high maxIbi status → blink reminder', () => {
    const r = makeResult();
    r.statuses.maxIbiMs = 'high';
    const rs = evaluateReminders(state({ lastWindowResult: r }));
    expect(rs.map((x) => x.kind)).toEqual(['blink']);
  });

  it('watch-level statuses are not enough for the blink reminder', () => {
    const r = makeResult();
    r.statuses.blinkRate = 'watch';
    r.statuses.maxIbiMs = 'watch';
    expect(evaluateReminders(state({ lastWindowResult: r }))).toEqual([]);
  });

  it('tired wins over blink when both apply (one result → one nudge)', () => {
    const r = makeResult({ fatigueScore: 90 });
    r.statuses.blinkRate = 'high';
    r.statuses.maxIbiMs = 'high';
    const rs = evaluateReminders(state({ lastWindowResult: r }));
    expect(rs).toHaveLength(1);
    expect(rs[0].kind).toBe('tired');
  });

  it('no window result → only break logic can fire', () => {
    expect(evaluateReminders(state({ lastWindowResult: null }))).toEqual([]);
    const due = state({
      monitorOnSince: T0 - CFG.monitorBreakEveryMs,
      lastWindowResult: null,
    });
    expect(evaluateReminders(due).map((r) => r.kind)).toEqual(['break']);
  });

  it('break and result reminders can coexist (different kinds)', () => {
    const s = state({
      monitorOnSince: T0 - CFG.monitorBreakEveryMs,
      lastWindowResult: makeResult({ fatigueScore: 100 }),
    });
    expect(evaluateReminders(s).map((r) => r.kind).sort()).toEqual(['break', 'tired']);
  });
});
