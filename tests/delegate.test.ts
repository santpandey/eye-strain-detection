import { describe, expect, it } from 'vitest';
import {
  chooseFaster,
  isSoftwareRenderer,
  median,
  newGpuWatch,
  pickInitialDelegate,
  recordGpuFrame,
  resolveOverride,
  shouldTryCpuFallback,
} from '../src/lib/vision/engine';
import { parseStoredDelegate } from '../src/lib/vision/client';

const FF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

describe('pickInitialDelegate', () => {
  it('defaults Firefox to CPU and others to GPU', () => {
    expect(pickInitialDelegate(FF)).toBe('CPU');
    expect(pickInitialDelegate(CHROME)).toBe('GPU');
  });
  it('honours an explicit override', () => {
    expect(pickInitialDelegate(FF, false)).toBe('GPU');
    expect(pickInitialDelegate(CHROME, true)).toBe('CPU');
  });
  it('defaults to CPU on software GL unless overridden', () => {
    expect(pickInitialDelegate(CHROME, undefined, true)).toBe('CPU');
    expect(pickInitialDelegate(CHROME, false, true)).toBe('GPU');
    expect(pickInitialDelegate(CHROME, undefined, false)).toBe('GPU');
  });
});

describe('isSoftwareRenderer', () => {
  it('flags software rasterisers and missing WebGL', () => {
    for (const r of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'softpipe',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Software Adapter',
      null,
      '',
    ]) {
      expect(isSoftwareRenderer(r), String(r)).toBe(true);
    }
  });
  it('accepts hardware renderers', () => {
    for (const r of [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Apple M1',
      'Mali-G78',
    ]) {
      expect(isSoftwareRenderer(r), r).toBe(false);
    }
  });
});

describe('median / chooseFaster', () => {
  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
  it('picks CPU only when clearly faster (< 0.8x GPU median)', () => {
    const gpu = Array(20).fill(300); // SwiftShader-like
    expect(chooseFaster(gpu, Array(10).fill(45))).toBe('CPU');
    expect(chooseFaster([10, 10, 10], [7.9, 7.9])).toBe('CPU');
    expect(chooseFaster([10, 10, 10], [8, 8])).toBe('GPU'); // exactly 0.8x: stay
    expect(chooseFaster([10, 10, 10], [9, 9])).toBe('GPU');
    expect(chooseFaster([8, 8, 8], [30, 30])).toBe('GPU'); // hardware GPU
  });
  it('is robust to outliers', () => {
    expect(chooseFaster([10, 10, 10, 10, 500], [9, 9, 9, 900, 900])).toBe('GPU');
    expect(chooseFaster([50, 50, 50, 1, 1], [20, 20, 20, 400])).toBe('CPU');
  });
  it('defaults to GPU without samples', () => {
    expect(chooseFaster([], [1])).toBe('GPU');
    expect(chooseFaster([1], [])).toBe('GPU');
  });
});

describe('persisted delegate override', () => {
  const R1 = 'ANGLE (NVIDIA, GeForce)';
  const R2 = 'ANGLE (Intel, UHD)';
  it('parses legacy plain strings (renderer-agnostic)', () => {
    expect(parseStoredDelegate('CPU')).toEqual({ delegate: 'CPU' });
    expect(parseStoredDelegate('GPU')).toEqual({ delegate: 'GPU' });
  });
  it('parses JSON records', () => {
    const raw = JSON.stringify({ delegate: 'CPU', renderer: R1, at: '2026-01-01T00:00:00Z', reason: 'faster' });
    expect(parseStoredDelegate(raw)).toEqual({
      delegate: 'CPU',
      renderer: R1,
      at: '2026-01-01T00:00:00Z',
      reason: 'faster',
    });
    expect(parseStoredDelegate(JSON.stringify({ delegate: 'CPU', renderer: null }))?.renderer).toBeNull();
  });
  it('rejects garbage', () => {
    for (const raw of [null, '', 'cpu', '{', '{"delegate":"TPU"}', 'null', '42']) {
      expect(parseStoredDelegate(raw), String(raw)).toBeUndefined();
    }
  });
  it('honours an override only on the renderer it was recorded on', () => {
    expect(resolveOverride(true, R1, R1)).toBe(true);
    expect(resolveOverride(true, R1, R2)).toBeUndefined();
    expect(resolveOverride(false, R1, null)).toBeUndefined();
    expect(resolveOverride(true, null, null)).toBe(true);
    // Legacy value: no renderer recorded -> always honoured.
    expect(resolveOverride(true, undefined, R2)).toBe(true);
    expect(resolveOverride(false, undefined, null)).toBe(false);
    expect(resolveOverride(undefined, R1, R1)).toBeUndefined();
  });
});

describe('shouldTryCpuFallback', () => {
  const feed = (n: number, fps: number, face = () => false) => {
    const w = newGpuWatch();
    for (let i = 0; i < n; i++) recordGpuFrame(w, 1000 + (i * 1000) / fps, face());
    return w;
  };

  it('waits for both 45 frames and 3 s', () => {
    // 45 frames at 30 fps = 1.47 s: not yet.
    expect(shouldTryCpuFallback(feed(45, 30))).toBe(false);
    // 3 s at 10 fps = 31 frames: not yet.
    expect(shouldTryCpuFallback(feed(31, 10))).toBe(false);
    // 91 frames at 30 fps = 3 s: yes.
    expect(shouldTryCpuFallback(feed(91, 30))).toBe(true);
    // 46 frames at 10 fps = 4.5 s: yes.
    expect(shouldTryCpuFallback(feed(46, 10))).toBe(true);
  });

  it('never fires once a face was seen', () => {
    let i = 0;
    const w = feed(200, 30, () => i++ === 10);
    expect(shouldTryCpuFallback(w)).toBe(false);
  });

  it('fires only once', () => {
    const w = feed(100, 30);
    expect(shouldTryCpuFallback(w)).toBe(true);
    w.attempted = true;
    recordGpuFrame(w, 99_999, false);
    expect(shouldTryCpuFallback(w)).toBe(false);
  });

  it('is false for an empty watch', () => {
    expect(shouldTryCpuFallback(newGpuWatch(), 0, 0)).toBe(false);
  });
});
