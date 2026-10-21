import { describe, expect, it, beforeEach } from 'vitest';
import { QualityCtx } from '../src/lib/analysis/quality';
import { frame, resetClock } from './helpers';

beforeEach(resetClock);

describe('QualityCtx', () => {
  it('drops noFace frames', () => {
    const ctx = new QualityCtx();
    const v = ctx.check(frame({ face: false }));
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('noFace');
  });

  it('drops headPose beyond 20°', () => {
    const ctx = new QualityCtx();
    expect(ctx.check(frame({ yaw: 30 })).reasons).toContain('headPose');
    expect(ctx.check(frame({ pitch: -25 })).reasons).toContain('headPose');
  });

  it('drops dark faces via faceLuma', () => {
    const ctx = new QualityCtx();
    const v = ctx.check(frame({ faceLuma: 30 }));
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('dark');
  });

  it('drops low-fps stretches after enough frames', () => {
    const ctx = new QualityCtx();
    // 11 frames spaced 200 ms apart → processed fps = 5.
    let t = 0;
    let v = ctx.check(frame());
    for (let i = 0; i < 11; i++) {
      const f = frame();
      t += 200;
      f.t = t;
      v = ctx.check(f);
    }
    expect(v.fps).toBeLessThan(15);
    expect(v.reasons).toContain('lowFps');
  });

  it('a 3 fps stream fires lowFps after ~1 s and reports fps ≈ 3', () => {
    const ctx = new QualityCtx();
    const firedAt: number[] = [];
    for (let i = 0; i < 30; i++) {
      const f = frame();
      f.t = 1000 + i * (1000 / 3);
      const v = ctx.check(f);
      if (v.reasons.includes('lowFps')) firedAt.push(f.t - 1000);
    }
    expect(firedAt.length).toBeGreaterThan(0);
    expect(firedAt[0]).toBeGreaterThanOrEqual(999);
    expect(firedAt[0]).toBeLessThanOrEqual(1400);
    // Every frame from the first judgement on is gated.
    expect(firedAt.length).toBe(30 - Math.round((firedAt[0] * 3) / 1000));
    const s = ctx.fpsSamples;
    expect(s.length).toBe(firedAt.length);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    expect(mean).toBeGreaterThan(2.8);
    expect(mean).toBeLessThan(3.2);
  });

  it('a 30 fps stream never fires lowFps', () => {
    const ctx = new QualityCtx();
    for (let i = 0; i < 300; i++) {
      const v = ctx.check(frame());
      expect(v.reasons).not.toContain('lowFps');
    }
    expect(ctx.fpsSamples.length).toBeGreaterThan(280);
    const mean = ctx.fpsSamples.reduce((a, b) => a + b, 0) / ctx.fpsSamples.length;
    expect(mean).toBeCloseTo(30, 0);
  });

  it('a lone frame after a long gap is judged as low fps', () => {
    const ctx = new QualityCtx();
    const a = frame();
    a.t = 0;
    ctx.check(a);
    const b = frame();
    b.t = 5000;
    const v = ctx.check(b);
    expect(v.reasons).toContain('lowFps');
    expect(v.fps).toBeCloseTo(0.5, 2); // 1 frame / 2 s window
  });

  it('drops high-motion frames', () => {
    const ctx = new QualityCtx();
    ctx.check(frame({ nose: [0.5, 0.5] }));
    const v = ctx.check(frame({ nose: [0.7, 0.5] })); // 0.2 normalized in 33 ms
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('motion');
  });

  it('does NOT drop glare frames, only flags them', () => {
    const ctx = new QualityCtx();
    const v = ctx.check(frame({ glare: [0.5, 0.1] }));
    expect(v.glare).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('does NOT drop backlit frames, only flags them', () => {
    const ctx = new QualityCtx();
    const v = ctx.check(frame({ frameLuma: 200, faceLuma: 100 }));
    expect(v.backlit).toBe(true);
    expect(v.ok).toBe(true);
  });
});
