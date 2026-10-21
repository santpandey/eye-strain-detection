import { describe, expect, it } from 'vitest';
import { decomposeRotation, computeFrameFeatures, estimateDistanceCm } from '../src/lib/vision/features';

function rotationMatrix(yawDeg: number, pitchDeg: number, rollDeg: number): number[] {
  const r = (d: number) => (d * Math.PI) / 180;
  const [cy, sy] = [Math.cos(r(yawDeg)), Math.sin(r(yawDeg))];
  const [cp, sp] = [Math.cos(r(pitchDeg)), Math.sin(r(pitchDeg))];
  const [cr, sr] = [Math.cos(r(rollDeg)), Math.sin(r(rollDeg))];
  // R = Ry * Rx * Rz, column-major 4x4.
  // Row-major form:
  // [ cy*cr+sy*sp*sr, -cy*sr+sy*sp*cr, sy*cp, tx ]
  // [ cp*sr,          cp*cr,          -sp,   ty ]
  // [ -sy*cr+cy*sp*sr, sy*sr+cy*sp*cr, cy*cp, tz ]
  // [ 0, 0, 0, 1 ]
  const m = [
    cy * cr + sy * sp * sr,
    cp * sr,
    -sy * cr + cy * sp * sr,
    0,
    -cy * sr + sy * sp * cr,
    cp * cr,
    sy * sr + cy * sp * cr,
    0,
    sy * cp,
    -sp,
    cy * cp,
    0,
    0,
    0,
    0,
    1,
  ];
  return m;
}

describe('decomposeRotation', () => {
  it('recovers yaw/pitch/roll from a synthetic rotation matrix', () => {
    const { yaw, pitch, roll } = decomposeRotation(rotationMatrix(30, 10, -5));
    expect(yaw).toBeCloseTo(30, 4);
    expect(pitch).toBeCloseTo(10, 4);
    expect(roll).toBeCloseTo(-5, 4);
  });

  it('handles identity', () => {
    const { yaw, pitch, roll } = decomposeRotation(rotationMatrix(0, 0, 0));
    expect(yaw).toBeCloseTo(0);
    expect(pitch).toBeCloseTo(0);
    expect(roll).toBeCloseTo(0);
  });
});

describe('computeFrameFeatures', () => {
  it('returns face:false with zeros when no landmarks', () => {
    const f = computeFrameFeatures({ faceLandmarks: [] }, 100, 640, 480, 80);
    expect(f.face).toBe(false);
    expect(f.earL).toBe(0);
    expect(f.frameLuma).toBe(80);
    expect(f.t).toBe(100);
  });
});

describe('estimateDistanceCm', () => {
  it('computes approx distance from iris px', () => {
    // f = 0.75*640 = 480; d = 480*1.17/12 = 46.8
    expect(estimateDistanceCm(12, 640)).toBeCloseTo(46.8, 1);
    expect(estimateDistanceCm(0, 640)).toBe(0);
  });
});
