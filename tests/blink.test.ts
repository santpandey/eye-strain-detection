import { describe, expect, it, beforeEach } from 'vitest';
import { BlinkDetector, timeAtOrAbove } from '../src/lib/analysis/blink';
import { CFG } from '../src/lib/analysis/config';
import { QualityCtx } from '../src/lib/analysis/quality';
import type { FrameFeatures } from '../src/lib/vision/types';
import { closed, feedAll, frame, halfClosed, noise, open, resetClock } from './helpers';

beforeEach(resetClock);

/** Set symmetric ear/blink so the detector's closure c equals `c` (earOpen 0.3). */
function withClosure(f: FrameFeatures, c: number): FrameFeatures {
  const ear = 0.3 * (1 - 0.6 * c); // EAR term: 0.5·(1−ear/0.3)/0.6 = 0.5·c
  return { ...f, earL: ear, earR: ear, blinkL: c, blinkR: c };
}

describe('BlinkDetector', () => {
  it('counts 10 normal 150 ms blinks over 60 s at ~10/min equivalent, all complete', () => {
    const det = new BlinkDetector();
    const seq = [];
    for (let i = 0; i < 10; i++) {
      seq.push(...open(174)); // ~5.8 s of open eyes between blinks
      seq.push(...closed(5)); // ~167 ms closure
    }
    seq.push(...open(10));
    feedAll(det, seq);
    det.finish(); // last event's post-window isn't covered → release unchecked
    expect(det.events.length).toBe(10);
    expect(det.events.every((e) => e.complete)).toBe(true);
    expect(det.events.every((e) => e.durationMs > 100 && e.durationMs < 250)).toBe(true);
    const rate = det.events.length / (det.qualityMs / 60000);
    expect(rate).toBeGreaterThan(9);
    expect(rate).toBeLessThan(11);
  });

  it('counts half-closures as incomplete blinks', () => {
    const det = new BlinkDetector();
    feedAll(det, [...open(60), ...halfClosed(5), ...open(60)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.peak).toBeGreaterThanOrEqual(0.45);
    expect(e.peak).toBeLessThan(0.8);
    expect(e.complete).toBe(false);
  });

  it('splits closed time into close/reopen phases at the peak', () => {
    const det = new BlinkDetector();
    // Fast close (1 frame), long flat peak, slow reopen ramp.
    const seq = [
      ...open(60),
      withClosure(frame(), 1.0),
      withClosure(frame(), 1.0),
      withClosure(frame(), 0.8),
      withClosure(frame(), 0.6),
      withClosure(frame(), 0.4),
      withClosure(frame(), 0.2),
      ...open(60),
    ];
    feedAll(det, seq);
    det.finish();
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.reopenMs).toBeGreaterThan(e.closeMs);
    expect(e.closeMs + e.reopenMs).toBeGreaterThan(0);
    expect(e.closeMs + e.reopenMs).toBeLessThanOrEqual(e.spanMs + 2 * CFG.dtCapMs);
  });

  it('flags an 800 ms complete closure as a long closure', () => {
    const det = new BlinkDetector();
    feedAll(det, [...open(60), ...closed(24), ...open(60)]);
    expect(det.events.length).toBe(1);
    expect(det.events[0].complete).toBe(true);
    expect(det.events[0].longClosure).toBe(true);
  });

  it('measures PERCLOS for a 2 s eyes-closed span', () => {
    const det = new BlinkDetector();
    const openSecs = 30;
    const closedSecs = 2;
    feedAll(det, [...open(openSecs * 30), ...closed(closedSecs * 30), ...open(30)]);
    // Quality time ≈ 32 s; closed fraction ≈ 2/32.
    expect(det.perclos).toBeGreaterThan(0.05);
    expect(det.perclos).toBeLessThan(0.08);
  });

  it('non-quality frames (yaw = 30) are gated out upstream', () => {
    const det = new BlinkDetector();
    const ctx = new QualityCtx();
    const feed = (seq: FrameFeatures[]) => {
      for (const f of seq) if (ctx.check(f).ok) det.push(f);
    };
    feed(open(30));
    const before = det.qualityMs;
    feed(open(30, { yaw: 30 }));
    expect(det.qualityMs).toBe(before);
    // A "blink" hidden inside bad frames is not seen.
    feed([...closed(5).map((f) => ({ ...f, yaw: 30 })), ...open(30)]);
    expect(det.events.length).toBe(0);
  });

  it('keeps blinks when lookDown rises at onset but returns to normal after', () => {
    const det = new BlinkDetector();
    feedAll(det, open(60));
    // lookDown spikes around the blink itself (lid drop reads as gaze-down)
    feedAll(det, open(3, { lookDown: 0.7 }));
    feedAll(det, closed(5, { lookDown: 0.7 }));
    feedAll(det, open(60));
    expect(det.events.length).toBe(1);
    expect(det.gazeDownDiscards).toBe(0);
  });

  it('discards closures followed by sustained gaze-down (post-event rise)', () => {
    const det = new BlinkDetector();
    feedAll(det, open(60));
    feedAll(det, closed(5));
    // user keeps looking down after the lids reopen: rest 0 → post ≈ 0.35
    feedAll(det, open(60, { lookDown: 0.35 }));
    expect(det.events.length).toBe(0);
    expect(det.gazeDownDiscards).toBe(1);
  });

  it('keeps blinks for a user with a high resting lookDown', () => {
    const det = new BlinkDetector();
    feedAll(det, open(60, { lookDown: 0.6 })); // this user's rest level
    feedAll(det, closed(5, { lookDown: 0.6 }));
    feedAll(det, open(60, { lookDown: 0.6 }));
    expect(det.events.length).toBe(1);
    expect(det.gazeDownDiscards).toBe(0);
  });

  it('flushes a pending event at end of stream via finish()', () => {
    const det = new BlinkDetector();
    feedAll(det, open(60));
    feedAll(det, closed(5));
    det.finish(); // no post-window frames: accepted unchecked
    expect(det.events.length).toBe(1);
    expect(det.gazeDownDiscards).toBe(0);
  });

  it('discards asymmetric closures (one eye open)', () => {
    const det = new BlinkDetector();
    feedAll(det, open(60));
    // left eye closes, right stays open; blink blendshape pushes c past start
    feedAll(det, open(5, { earL: 0, blinkL: 0.7, blinkR: 0.7 }));
    feedAll(det, open(60));
    expect(det.events.length).toBe(0);
    expect(det.asymmetricDiscards).toBe(1);
  });

  it('discards sub-promStart noise wiggles (prominence ≈ 0.15)', () => {
    const det = new BlinkDetector();
    feedAll(det, [...open(60), ...noise(4), ...open(60)]);
    expect(det.events.length).toBe(0);
  });

  it('counts inter-blink gaps > 10 s', () => {
    const det = new BlinkDetector();
    feedAll(det, [
      ...open(30),
      ...closed(5), // blink 1
      ...open(30 * 12), // 12 s gap
      ...closed(5), // blink 2
      ...open(30 * 5),
      ...closed(5), // blink 3, gap 5 s
      ...open(30),
    ]);
    expect(det.events.length).toBe(3);
    const gaps = det.interBlinkIntervals;
    // leading ~1 s, 12 s, 5 s, trailing ~1 s
    expect(gaps.length).toBe(4);
    expect(gaps[1]).toBeGreaterThan(10_000);
    expect(gaps.filter((g) => g > 10_000).length).toBe(1);
  });

  it('reports the whole quality span as the gap when there are no blinks', () => {
    const det = new BlinkDetector();
    feedAll(det, open(15 * 30)); // 15 s, zero blinks
    const gaps = det.interBlinkIntervals;
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toBeGreaterThan(14_000);
    expect(gaps[0]).toBeLessThanOrEqual(15_000);
    expect(gaps.filter((g) => g > 10_000).length).toBe(1);
  });

  it('counts a leading gap before the first blink', () => {
    const det = new BlinkDetector();
    feedAll(det, [...open(30 * 12), ...closed(5), ...open(30 * 5)]);
    const gaps = det.interBlinkIntervals;
    expect(gaps[0]).toBeGreaterThan(11_000);
    expect(gaps.filter((g) => g > 10_000).length).toBe(1);
  });

  it('measures duration as time c ≥ 0.5, not the hysteresis span (slow tails)', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300)); // earOpen baseline ≈ 0.3
    // Piecewise-linear closure profile c(τ), τ in ms from blink onset:
    // slow 300 ms tail 0→0.45, steep to 1, plateau, steep to 0.45, slow
    // 400 ms tail back to 0. c ≥ 0.5 from τ=301.8 to τ=451.8 → 150 ms.
    const pts: [number, number][] = [
      [0, 0],
      [300, 0.45],
      [320, 1],
      [433.6, 1],
      [453.6, 0.45],
      [853.6, 0],
    ];
    const cAt = (tau: number) => {
      if (tau <= 0 || tau >= pts[pts.length - 1][0]) return 0;
      for (let i = 1; i < pts.length; i++) {
        const [t0, c0] = pts[i - 1];
        const [t1, c1] = pts[i];
        if (tau <= t1) return c0 + ((c1 - c0) * (tau - t0)) / (t1 - t0);
      }
      return 0;
    };
    const f0 = frame(); // open (c=0) at τ=0
    det.push(f0);
    const onset = f0.t;
    const seq: FrameFeatures[] = [];
    for (let i = 0; i < 40; i++) {
      const f = frame();
      seq.push(withClosure(f, cAt(f.t - onset)));
    }
    feedAll(det, [...seq, ...open(30)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.complete).toBe(true);
    expect(Math.abs(e.closedMs - 150)).toBeLessThanOrEqual(34);
    expect(e.durationMs).toBe(e.closedMs);
    expect(e.spanMs).toBeGreaterThan(400); // old metric inflated by tails
    expect(e.longClosure).toBe(false);
  });

  it('uses time above peak/2 for incomplete blinks peaking below 0.5', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300));
    // c: 0 → 0.48 plateau for 5 frames (~167 ms) → 0
    const seq = Array.from({ length: 5 }, () => withClosure(frame(), 0.48));
    feedAll(det, [...seq, ...open(30)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.peak).toBeLessThan(0.5);
    expect(e.closedMs).toBeGreaterThan(130);
    expect(e.closedMs).toBeLessThan(200);
  });

  it('real-clip blink profile reports a short duration', () => {
    const det = new BlinkDetector();
    const base = 0.31;
    feedAll(det, open(300, { earL: base, earR: base }));
    const rows: [number, number][] = [
      [0.082, 0.61],
      [0.037, 0.68],
      [0.036, 0.67],
      [0.035, 0.67],
      [0.033, 0.67],
      [0.096, 0.52],
      [0.178, 0.32],
      [0.25, 0.15],
    ];
    for (const [ear, blink] of rows) {
      det.push(frame({ earL: ear, earR: ear, blinkL: blink, blinkR: blink }));
    }
    feedAll(det, open(30, { earL: base, earR: base }));
    expect(det.events.length).toBe(1);
    expect(det.events[0].closedMs).toBeLessThan(300);
  });

  it('caps a 600 ms gap of missing frames inside an event', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300));
    feedAll(det, closed(3));
    open(18); // ~600 ms of frames dropped by quality gating (never pushed)
    feedAll(det, [...closed(3), ...open(30)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.spanMs).toBeGreaterThan(600);
    expect(e.closedMs).toBeGreaterThanOrEqual(0);
    expect(e.closedMs).toBeLessThanOrEqual(e.spanMs + 200);
    // ~6 closed frames (~167 ms) + gap capped at 100 ms
    expect(e.closedMs).toBeLessThan(350);
  });

  it('ignores a pre-event frame 2 s before the event start', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300));
    open(60); // 2 s gated out → last pushed frame is 2 s before the blink
    feedAll(det, [...closed(5), ...open(30)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.closedMs).toBeLessThanOrEqual(e.spanMs + 200);
    expect(e.closedMs).toBeGreaterThan(100);
    expect(e.closedMs).toBeLessThan(250);
  });

  it('measures a sensible duration for a peak just above 0.5 (no slivers)', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300));
    // c > 0.255 (= peak/2) for ~150-180 ms; c ≥ 0.5 only at the single peak frame
    const cs = [0.3, 0.45, 0.51, 0.48, 0.45, 0.3, 0.1];
    feedAll(det, [...cs.map((c) => withClosure(frame(), c)), ...open(30)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.peak).toBeCloseTo(0.51, 2);
    expect(e.closedMs).toBeGreaterThan(80);
    expect(e.closedMs).toBeLessThan(250);
  });

  it('timeAtOrAbove caps long intervals and skips crossings across gaps', () => {
    // both endpoints in, 600 ms apart → contributes the 100 ms cap
    expect(timeAtOrAbove([{ t: 0, c: 1 }, { t: 600, c: 1 }], 0.5, 100)).toBe(100);
    // crossing across a 2 s gap → contributes nothing
    expect(timeAtOrAbove([{ t: 0, c: 0 }, { t: 2000, c: 1 }], 0.5, 100)).toBe(0);
    // crossing within a normal interval → interpolated
    expect(timeAtOrAbove([{ t: 0, c: 0 }, { t: 40, c: 1 }], 0.5, 100)).toBeCloseTo(20);
  });

  it('splits three rapid blinks with valleys at c = 0.3 into 3 events, no long closure', () => {
    const blink = [0.6, 1, 1, 1, 0.6];
    for (const valleyFrames of [3, 10]) {
      resetClock();
      const det = new BlinkDetector();
      feedAll(det, open(300));
      const valley = Array(valleyFrames).fill(0.3);
      const cs = [...blink, ...valley, ...blink, ...valley, ...blink, 0.3, 0.1];
      feedAll(det, [...cs.map((c) => withClosure(frame(), c)), ...open(60)]);
      expect(det.events.length, `valley ${valleyFrames} frames`).toBe(3);
      expect(det.events.every((e) => e.complete && !e.longClosure)).toBe(true);
      expect(det.events.every((e) => e.closedMs < 250)).toBe(true);
    }
  });

  it('follows a rest level drifting 0.03 → 0.2: every blink found, none merged', () => {
    const det = new BlinkDetector();
    const total = 60 * 30; // 60 s
    const blinkEvery = 60; // a blink every 2 s
    const profile = [0.6, 1, 1, 1, 0.6];
    const blinkStarts: number[] = [];
    for (let i = 0; i < total; i++) {
      const r = 0.03 + (0.17 * i) / total; // resting c, carried by the blendshape
      const k = i % blinkEvery;
      if (i >= 300 && k < profile.length) {
        const f = withClosure(frame(), Math.max(r, profile[k]));
        if (k === 0) blinkStarts.push(f.t);
        det.push(f);
      } else {
        det.push(frame({ blinkL: 2 * r, blinkR: 2 * r }));
      }
    }
    expect(det.events.length).toBe(blinkStarts.length);
    for (const t of blinkStarts) {
      const hits = det.events.filter((e) => e.start <= t + 40 && e.end >= t);
      expect(hits.length, `blink at ${Math.round(t)}`).toBe(1);
    }
    expect(det.events.some((e) => e.longClosure)).toBe(false);
    // Late events are measured against the drifted rest level.
    expect(det.events[det.events.length - 1].rest).toBeGreaterThan(0.15);
  });

  it('ignores a 0.15-prominence wiggle on an elevated rest level', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300, { blinkL: 0.4, blinkR: 0.4 })); // rest c ≈ 0.2
    feedAll(det, [
      ...open(4, { blinkL: 0.7, blinkR: 0.7 }), // c ≈ 0.35
      ...open(60, { blinkL: 0.4, blinkR: 0.4 }),
    ]);
    expect(0.15).toBeLessThan(CFG.promStart);
    expect(det.events.length).toBe(0);
  });

  it('keeps a real 1.2 s closure (c ≥ 0.9, no valley) as one long closure', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300));
    const cs = Array.from({ length: 36 }, (_, i) => (i % 2 ? 0.9 : 1));
    feedAll(det, [...cs.map((c) => withClosure(frame(), c)), ...open(60)]);
    expect(det.events.length).toBe(1);
    const e = det.events[0];
    expect(e.complete).toBe(true);
    expect(e.longClosure).toBe(true);
    expect(e.closedMs).toBeGreaterThan(1000);
  });

  it('ignores zero-closure baseline drift (earOpen from history)', () => {
    const det = new BlinkDetector();
    feedAll(det, open(300)); // 10 s of steady open frames → earOpen ≈ 0.3
    feedAll(det, [...closed(4), ...open(30)]);
    expect(det.events.length).toBe(1);
    expect(det.events[0].complete).toBe(true);
  });
});
