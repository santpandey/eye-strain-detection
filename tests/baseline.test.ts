import { describe, expect, it } from 'vitest';
import {
  BASELINE_METRICS,
  baselineMedian,
  baselineReady,
  contribute,
  deltaText,
  emptyBaseline,
  normalizeBaseline,
  usualDeltaPct,
} from '../src/lib/analysis/baseline';
import { CFG } from '../src/lib/analysis/config';
import { makeResult } from './helpers';

describe('baseline: contribute + reservoirs', () => {
  it('emptyBaseline is not ready and has no samples', () => {
    const b = emptyBaseline();
    expect(b.sessions).toBe(0);
    for (const m of BASELINE_METRICS) expect(b.samples[m]).toEqual([]);
    expect(baselineReady(b)).toBe(false);
  });

  it('each saved session contributes one sample per metric and bumps sessions', () => {
    let b = emptyBaseline();
    b = contribute(b, makeResult({ meanBlinkMs: 150 }));
    b = contribute(b, makeResult({ meanBlinkMs: 170 }));
    b = contribute(b, makeResult({ meanBlinkMs: 160 }));
    expect(b.sessions).toBe(3);
    expect(b.samples.meanBlinkMs).toEqual([150, 170, 160]);
    expect(b.samples.blinkRate).toEqual([15, 15, 15]);
    expect(baselineMedian(b, 'meanBlinkMs')).toBe(160);
    expect(baselineMedian(b, 'blinkRate')).toBe(15);
  });

  it('does not mutate the previous record', () => {
    const b1 = contribute(emptyBaseline(), makeResult());
    const before = b1.samples.meanBlinkMs.slice();
    contribute(b1, makeResult({ meanBlinkMs: 999 }));
    expect(b1.samples.meanBlinkMs).toEqual(before);
    expect(b1.sessions).toBe(1);
  });

  it('skips metrics marked na for that session', () => {
    const r = makeResult();
    r.statuses.meanBlinkMs = 'na';
    r.statuses.reopenFrac = 'na';
    r.statuses.incompleteRatio = 'na';
    const b = contribute(emptyBaseline(), r);
    expect(b.sessions).toBe(1);
    expect(b.samples.meanBlinkMs).toEqual([]);
    expect(b.samples.meanReopenFrac).toEqual([]);
    expect(b.samples.incompleteRatio).toEqual([]);
    // perclos and blinkRate are never na — still recorded.
    expect(b.samples.perclos).toEqual([r.perclos]);
    expect(b.samples.blinkRate).toEqual([r.blinkRate]);
  });

  it('skips blinkRate when the session had no usable footage', () => {
    const b = contribute(emptyBaseline(), makeResult({ qualityMs: 0, blinkRate: 0 }));
    expect(b.samples.blinkRate).toEqual([]);
    expect(b.sessions).toBe(1);
  });

  it('reservoir caps at CFG.baselineReservoir, dropping the oldest values', () => {
    let b = emptyBaseline();
    for (let i = 0; i < CFG.baselineReservoir + 10; i++) {
      b = contribute(b, makeResult({ perclos: i }));
    }
    expect(b.samples.perclos.length).toBe(CFG.baselineReservoir);
    expect(b.samples.perclos[0]).toBe(10); // first ten evicted
    expect(b.sessions).toBe(CFG.baselineReservoir + 10);
  });
});

describe('baseline: median + readiness', () => {
  it('median handles odd and even sample counts', () => {
    let b = emptyBaseline();
    b = contribute(b, makeResult({ meanBlinkMs: 100 }));
    b = contribute(b, makeResult({ meanBlinkMs: 300 }));
    b = contribute(b, makeResult({ meanBlinkMs: 200 }));
    expect(baselineMedian(b, 'meanBlinkMs')).toBe(200);
    b = contribute(b, makeResult({ meanBlinkMs: 400 }));
    expect(baselineMedian(b, 'meanBlinkMs')).toBe(250);
  });

  it('baselineReady flips at CFG.baselineMinSessions contributing sessions', () => {
    let b = emptyBaseline();
    for (let i = 0; i < CFG.baselineMinSessions - 1; i++) {
      b = contribute(b, makeResult());
      expect(baselineReady(b)).toBe(false);
    }
    b = contribute(b, makeResult());
    expect(baselineReady(b)).toBe(true);
  });

  it('baselineMedian returns null for metrics with no samples', () => {
    expect(baselineMedian(emptyBaseline(), 'perclos')).toBeNull();
    expect(baselineMedian(null, 'perclos')).toBeNull();
    expect(baselineMedian(undefined, 'perclos')).toBeNull();
  });
});

describe('baseline: deltas + formatting', () => {
  it('usualDeltaPct is signed % difference vs the median', () => {
    expect(usualDeltaPct(20, 10)).toBe(100);
    expect(usualDeltaPct(5, 10)).toBe(-50);
    expect(usualDeltaPct(10, 10)).toBe(0);
  });
  it('usualDeltaPct is null when not comparable', () => {
    expect(usualDeltaPct(5, null)).toBeNull();
    expect(usualDeltaPct(5, 0)).toBeNull(); // 0 median, nonzero value → no sane %
    expect(usualDeltaPct(0, 0)).toBe(0);
    expect(usualDeltaPct(NaN, 10)).toBeNull();
  });
  it('deltaText renders signed percents and caps extremes', () => {
    expect(deltaText(-38.4)).toBe('−38%');
    expect(deltaText(12)).toBe('+12%');
    expect(deltaText(0)).toBe('0%');
    expect(deltaText(1500)).toBe('>10×');
    expect(deltaText(NaN)).toBe('—');
  });
});

describe('baseline: normalizeBaseline', () => {
  it('recovers from garbage / missing data', () => {
    expect(normalizeBaseline(undefined).sessions).toBe(0);
    expect(normalizeBaseline(null).sessions).toBe(0);
    expect(normalizeBaseline('junk').sessions).toBe(0);
    expect(normalizeBaseline({ sessions: 'x' }).sessions).toBe(0);
  });
  it('keeps finite samples, drops non-finite, caps length', () => {
    const b = normalizeBaseline({
      sessions: 4.9,
      samples: { perclos: [1, NaN, 2, 'x', 3], meanBlinkMs: 'nope' },
    });
    expect(b.sessions).toBe(4);
    expect(b.samples.perclos).toEqual([1, 2, 3]);
    expect(b.samples.meanBlinkMs).toEqual([]);
  });
});
