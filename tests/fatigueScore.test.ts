import { describe, expect, it } from 'vitest';
import { fatigueScore, scoreTier } from '../src/lib/analysis/fatigueScore';
import { contribute, emptyBaseline, type BaselineStats } from '../src/lib/analysis/baseline';
import { CFG } from '../src/lib/analysis/config';
import { makeResult } from './helpers';

/** A baseline built from N copies of `r` (default: enough to be ready). */
function baselineOf(
  r: ReturnType<typeof makeResult>,
  n: number = CFG.baselineMinSessions,
): BaselineStats {
  let b = emptyBaseline();
  for (let i = 0; i < n; i++) b = contribute(b, r);
  return b;
}

describe('fatigueScore: gating', () => {
  it('low confidence → null score', () => {
    const r = makeResult({ confidence: 'low' });
    expect(fatigueScore(r, null).score).toBeNull();
  });
  it('fewer than scoreMinEvents blink events → null score', () => {
    const r = makeResult({ completeBlinks: 2, incompleteBlinks: 2 });
    expect(fatigueScore(r, null).score).toBeNull();
    const ok = makeResult({ completeBlinks: CFG.scoreMinEvents, incompleteBlinks: 0 });
    expect(fatigueScore(ok, null).score).not.toBeNull();
  });
  it('all fatigue metrics na → null score, empty parts', () => {
    const r = makeResult();
    r.statuses.meanBlinkMs = 'na';
    r.statuses.reopenFrac = 'na';
    r.statuses.incompleteRatio = 'na';
    r.statuses.perclos = 'na';
    const out = fatigueScore(r, null);
    expect(out.parts).toEqual([]);
    expect(out.score).toBeNull();
  });
});

describe('fatigueScore: no baseline (population anchors)', () => {
  it('marks every part estimated and baselineReady false', () => {
    const out = fatigueScore(makeResult(), null);
    expect(out.baselineReady).toBe(false);
    expect(out.parts.length).toBe(4);
    expect(out.parts.every((p) => p.estimated)).toBe(true);
    expect(out.parts.every((p) => p.deltaPct === null)).toBe(true);
  });
  it('values at the population watch thresholds score ≈ 33 (r/(r+2) at r=1)', () => {
    const r = makeResult({
      perclos: CFG.perclosWatch,
      meanBlinkMs: CFG.meanBlinkWatchMs,
      meanReopenFrac: CFG.reopenFracWatch,
      incompleteRatio: CFG.incompleteWatch,
    });
    const out = fatigueScore(r, null);
    expect(out.score).not.toBeNull();
    expect(out.score!).toBeGreaterThanOrEqual(32);
    expect(out.score!).toBeLessThanOrEqual(34);
    for (const p of out.parts) expect(p.sub).toBeCloseTo(1 / 3, 3);
  });
  it('monotonic: a worse (higher) metric raises the score', () => {
    const calm = fatigueScore(makeResult({ meanBlinkMs: 150 }), null).score!;
    const heavy = fatigueScore(makeResult({ meanBlinkMs: 450 }), null).score!;
    expect(heavy).toBeGreaterThan(calm);
    const calmAll = fatigueScore(
      makeResult({ perclos: 0.01, meanBlinkMs: 120, meanReopenFrac: 0.4, incompleteRatio: 0.05 }),
      null,
    ).score!;
    const tiredAll = fatigueScore(
      makeResult({ perclos: 0.2, meanBlinkMs: 500, meanReopenFrac: 0.9, incompleteRatio: 0.6 }),
      null,
    ).score!;
    expect(tiredAll).toBeGreaterThan(calmAll);
    expect(tiredAll).toBeLessThanOrEqual(100);
  });
});

describe('fatigueScore: personal baseline anchors', () => {
  it('a typical session scores ≈ 33 with deltaPct ≈ 0 per part', () => {
    const base = makeResult();
    const out = fatigueScore(makeResult(), baselineOf(base));
    expect(out.baselineReady).toBe(true);
    expect(out.score!).toBeGreaterThanOrEqual(32);
    expect(out.score!).toBeLessThanOrEqual(34);
    for (const p of out.parts) {
      expect(p.estimated).toBe(false);
      expect(p.deltaPct).toBeCloseTo(0, 6);
      expect(p.sub).toBeCloseTo(1 / 3, 3);
    }
  });
  it('doubling a metric vs usual: deltaPct +100, sub 1/2, score rises', () => {
    const base = makeResult({ meanBlinkMs: 200 });
    const out = fatigueScore(makeResult({ meanBlinkMs: 400 }), baselineOf(base));
    const part = out.parts.find((p) => p.metric === 'meanBlinkMs')!;
    expect(part.deltaPct).toBeCloseTo(100, 6);
    expect(part.sub).toBeCloseTo(0.5, 3);
    const atUsual = fatigueScore(makeResult({ meanBlinkMs: 200 }), baselineOf(base)).score!;
    expect(out.score!).toBeGreaterThan(atUsual);
  });
  it('not-ready baseline (< min sessions) → population anchors, estimated', () => {
    const b = baselineOf(makeResult(), CFG.baselineMinSessions - 1);
    const out = fatigueScore(makeResult(), b);
    expect(out.baselineReady).toBe(false);
    expect(out.parts.every((p) => p.estimated)).toBe(true);
  });
  it('metric missing from an otherwise-ready baseline → estimated for that part only', () => {
    // Baseline whose perclos samples were all 'na'… simulate by wiping.
    const b = baselineOf(makeResult());
    b.samples.perclos = [];
    const out = fatigueScore(makeResult({ perclos: 0.1 }), b);
    const perclos = out.parts.find((p) => p.metric === 'perclos')!;
    expect(perclos.estimated).toBe(true);
    const ratio = 0.1 / CFG.perclosWatch;
    expect(perclos.sub).toBeCloseTo(ratio / (ratio + CFG.scoreSaturateK), 3);
    const others = out.parts.filter((p) => p.metric !== 'perclos');
    expect(others.every((p) => !p.estimated)).toBe(true);
  });
});

describe('fatigueScore: explainability + tiers', () => {
  it('parts carry metric, label, weight, sub, contribution, deltaPct, estimated', () => {
    const out = fatigueScore(makeResult(), null);
    for (const p of out.parts) {
      expect(p.metric).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.weight).toBeGreaterThan(0);
      expect(p.sub).toBeGreaterThanOrEqual(0);
      expect(p.sub).toBeLessThanOrEqual(1);
      expect(p.contribution).toBeCloseTo(p.weight * p.sub, 9);
      expect('deltaPct' in p).toBe(true);
      expect(typeof p.estimated).toBe('boolean');
    }
  });
  it('na metrics are excluded and remaining weights renormalise', () => {
    const r = makeResult();
    r.statuses.incompleteRatio = 'na';
    const out = fatigueScore(r, null);
    expect(out.parts.map((p) => p.metric)).not.toContain('incompleteRatio');
    expect(out.parts.length).toBe(3);
    const wSum = out.parts.reduce((s, p) => s + p.weight, 0);
    const expectScore = Math.round(100 * (out.parts.reduce((s, p) => s + p.contribution, 0) / wSum));
    expect(out.score).toBe(expectScore);
  });
  it('scoreTier thresholds', () => {
    expect(scoreTier(CFG.scoreWatch - 1)).toBe('good');
    expect(scoreTier(CFG.scoreWatch)).toBe('watch');
    expect(scoreTier(CFG.scoreHigh - 1)).toBe('watch');
    expect(scoreTier(CFG.scoreHigh)).toBe('high');
  });
});
