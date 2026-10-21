import { describe, expect, it } from 'vitest';
import { assessConfidence, poissonInterval, QuickCheckAggregator } from '../src/lib/analysis/session';
import { frame, resetClock } from './helpers';
import { assess, overallVerdict } from '../src/lib/analysis/thresholds';
import { matchBlinks } from '../src/lib/analysis/eval';
import { CFG } from '../src/lib/analysis/config';

describe('poissonInterval', () => {
  it('n=10 gives ≈4.80 lower and ≈18.39 upper', () => {
    const { lower, upper } = poissonInterval(10);
    expect(lower).toBeCloseTo(4.8, 1);
    expect(Math.abs(lower - 4.8) / 4.8).toBeLessThan(0.02);
    expect(Math.abs(upper - 18.39) / 18.39).toBeLessThan(0.02);
  });
  it('n=0 gives lower 0', () => {
    expect(poissonInterval(0).lower).toBe(0);
  });
});

describe('assessConfidence', () => {
  const good = {
    qualityMs: 90_000,
    qualityPct: 95,
    fpsMean: 29,
    glarePct: 0,
    backlitPct: 0,
    discardPct: 0,
    candidateCount: 0,
  };
  it('high tier when all criteria pass', () => {
    const r = assessConfidence(good);
    expect(r.confidence).toBe('high');
    expect(r.reasons).toEqual([]);
  });
  it('medium tier with moderate shortfalls + reasons', () => {
    const r = assessConfidence({ ...good, qualityMs: 65_000, fpsMean: 20 });
    expect(r.confidence).toBe('medium');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.text.includes('usable footage'))).toBe(true);
    expect(r.reasons.some((x) => x.text.includes('fps'))).toBe(true);
    expect(r.reasons.every((x) => x.fix.length > 0)).toBe(true);
  });
  it('low tier below medium floors', () => {
    const r = assessConfidence({ ...good, qualityMs: 10_000 });
    expect(r.confidence).toBe('low');
  });
  it('flags glare and backlight reasons', () => {
    const r = assessConfidence({ ...good, glarePct: 22, backlitPct: 30 });
    expect(r.reasons.some((x) => x.text.includes('Reflections'))).toBe(true);
    expect(r.reasons.some((x) => x.text.includes('backlight'))).toBe(true);
  });
  it('abstains (low) when discards exceed maxDiscardPct with enough candidates', () => {
    const r = assessConfidence({ ...good, discardPct: 55, candidateCount: 20 });
    expect(r.confidence).toBe('low');
    expect(r.reasons.some((x) => x.text.includes('discarded'))).toBe(true);
  });
  it('does not abstain on high discardPct with too few candidates', () => {
    const r = assessConfidence({ ...good, discardPct: 55, candidateCount: 3 });
    expect(r.confidence).not.toBe('low');
  });
});

describe('per-metric minimums (na)', () => {
  const core = {
    blinkRate: 14,
    incompleteRatio: 0.1,
    meanBlinkMs: 150,
    meanReopenFrac: 0.6,
    perclos: 0.01,
    maxIbiMs: 4000,
    distanceCm: 55,
    luma: 120,
  };
  it('meanBlinkMs is na below 5 events', () => {
    expect(assess(core, 4).statuses.meanBlinkMs).toBe('na');
    expect(assess(core, 5).statuses.meanBlinkMs).not.toBe('na');
  });
  it('incompleteRatio is na below 8 events', () => {
    expect(assess(core, 7).statuses.incompleteRatio).toBe('na');
    expect(assess(core, 8).statuses.incompleteRatio).toBe('good');
  });
  it('distance is na for file sources, assessed for camera', () => {
    expect(assess(core, 10, false).statuses.distanceCm).toBe('na');
    const cam = assess(core, 10, true);
    expect(cam.statuses.distanceCm).toBe('good');
    // no distance tip when na
    const file = assess({ ...core, distanceCm: 30 }, 10, false);
    expect(file.statuses.distanceCm).toBe('na');
    expect(file.tips.every((t) => !t.includes('cm from the screen'))).toBe(true);
  });
  it('reopenFrac is na below 5 events and tiered above', () => {
    expect(assess(core, 4).statuses.reopenFrac).toBe('na');
    expect(assess(core, 5).statuses.reopenFrac).toBe('good');
    expect(assess({ ...core, meanReopenFrac: 0.8 }, 5).statuses.reopenFrac).toBe('watch');
    expect(assess({ ...core, meanReopenFrac: 0.9 }, 5).statuses.reopenFrac).toBe('high');
  });
});

describe('overallVerdict (fatigue vs task-context signals)', () => {
  const core = {
    blinkRate: 14,
    incompleteRatio: 0.1,
    meanBlinkMs: 150,
    meanReopenFrac: 0.6,
    perclos: 0.01,
    maxIbiMs: 4000,
    distanceCm: 55,
    luma: 120,
  };
  const st = (c: typeof core, n = 10) => assess(c, n).statuses;
  it('a lone low blink rate does NOT pronounce tiredness — it is task context', () => {
    expect(overallVerdict(st({ ...core, blinkRate: 3 }))).toBe('Screen-focus strain signs');
  });
  it('fatigue signals (heavy blinks, partial share, closure time, slow reopen) do', () => {
    expect(overallVerdict(st({ ...core, meanBlinkMs: 500 }))).toBe('Your eyes look tired');
    expect(overallVerdict(st({ ...core, incompleteRatio: 0.7 }))).toBe('Your eyes look tired');
    expect(overallVerdict(st({ ...core, meanReopenFrac: 0.9 }))).toBe('Your eyes look tired');
    expect(overallVerdict(st({ ...core, perclos: 0.2 }))).toBe('Your eyes look tired');
  });
  it('fatigue outranks context when both fire', () => {
    expect(
      overallVerdict(st({ ...core, blinkRate: 3, meanBlinkMs: 350 })),
    ).toBe('A few things to watch');
  });
  it('all-clear sessions still look good', () => {
    expect(overallVerdict(st(core))).toBe('Looking good');
  });
});

describe('matchBlinks', () => {
  const ev = (s: number, d = 150) => ({ start: s, end: s + d });
  it('exact matches score perfectly', () => {
    const r = matchBlinks([ev(1000), ev(3000)], [1050, 3050], 1);
    expect(r.tp).toBe(2);
    expect(r.f1).toBe(1);
  });
  it('tolerance edges: label at start-tol and end+tol both match', () => {
    const tol = CFG.matchTolMs;
    const r = matchBlinks([ev(1000)], [1000 - tol], 1);
    expect(r.tp).toBe(1);
    const r2 = matchBlinks([ev(1000)], [1000 + 150 + tol], 1);
    expect(r2.tp).toBe(1);
  });
  it('just outside tolerance → fp + fn', () => {
    const tol = CFG.matchTolMs;
    const r = matchBlinks([ev(1000)], [1000 - tol - 1], 1);
    expect(r.tp).toBe(0);
    expect(r.fp).toBe(1);
    expect(r.fn).toBe(1);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
  });
  it('rateErrorPerMin reflects detected − true per quality minute', () => {
    const r = matchBlinks([ev(1000), ev(2000), ev(3000)], [1000], 1);
    expect(r.rateErrorPerMin).toBeCloseTo(2);
  });
});

describe('low-fps streams', () => {
  it('3 fps: frames are gated, so the dt cap cannot accrue quality time; fpsMean ≈ 3', () => {
    resetClock();
    const agg = new QuickCheckAggregator();
    for (let i = 0; i < 30; i++) {
      const f = frame();
      f.t = 1000 + i * (1000 / 3); // 10 s at 3 fps
      agg.push(f);
    }
    // Only the frames before the first fps judgement (~1 s) reach the
    // detector; each contributes at most dtCapMs.
    expect(agg.detector.qualityMs).toBeLessThanOrEqual(3 * CFG.dtCapMs);
    const r = agg.result();
    expect(r.qualityPct).toBeLessThan(5);
    expect(r.fpsMean).toBeGreaterThan(2.8);
    expect(r.fpsMean).toBeLessThan(3.2);
  });
});
