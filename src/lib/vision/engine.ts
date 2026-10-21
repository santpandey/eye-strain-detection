import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  computeFrameFeatures,
  eyeBox,
  faceBox,
  EYE_CONTOUR_L,
  EYE_CONTOUR_R,
  type NormBox,
} from './features';
import type { DelegateTiming, FrameFeatures, SwitchReason } from './types';
import { CFG } from '../analysis/config';

export type Delegate = 'GPU' | 'CPU';

export interface FrameResult {
  f: FrameFeatures;
  /** Set on the one frame where the engine switched GPU -> CPU at runtime. */
  switchedDelegate?: 'CPU';
  switchReason?: SwitchReason;
  /** Set on the one frame where the startup GPU/CPU benchmark finished. */
  timing?: DelegateTiming;
}

export interface VisionEngine {
  /** Active delegate; may change once from GPU to CPU (see FrameResult). */
  readonly delegate: Delegate;
  /** WebGL renderer string (null: WebGL unavailable). */
  readonly renderer: string | null;
  /** True when WebGL is software-rendered or unavailable. */
  readonly software: boolean;
  processFrame(bitmap: ImageBitmap, t: number): Promise<FrameResult>;
  close(): void;
}

export interface VisionEngineOptions {
  /**
   * true: CPU first; false: GPU first even on Firefox;
   * undefined: auto (Firefox / software GL -> CPU, others -> GPU + benchmark).
   */
  preferCPU?: boolean;
  /**
   * Renderer the persisted override was recorded on. If defined and it
   * differs from the current renderer, `preferCPU` is ignored (auto).
   */
  overrideRenderer?: string | null;
}

/**
 * Initial delegate. MediaPipe's GPU path isn't supported in Firefox and has
 * been seen to initialise fine yet return no faces, so Firefox defaults to CPU.
 * On software WebGL (SwiftShader, llvmpipe, ...) or without WebGL the GPU
 * delegate is far slower than XNNPACK, so those default to CPU too.
 */
export function pickInitialDelegate(
  userAgent: string,
  preferCPU?: boolean,
  softwareGL = false,
): Delegate {
  if (preferCPU !== undefined) return preferCPU ? 'CPU' : 'GPU';
  if (softwareGL) return 'CPU';
  return /firefox/i.test(userAgent) ? 'CPU' : 'GPU';
}

const SOFTWARE_RENDERER_RE =
  /swiftshader|llvmpipe|softpipe|software|basic render driver|microsoft basic/i;

/** True for software rasterisers, and for "no WebGL" (null / empty). */
export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  return !renderer || SOFTWARE_RENDERER_RE.test(renderer);
}

/**
 * WebGL renderer string via an OffscreenCanvas (works in workers):
 * UNMASKED_RENDERER_WEBGL when available, else RENDERER. null if no WebGL.
 */
export function probeWebGLRenderer(): string | null {
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const canvas = new OffscreenCanvas(1, 1);
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext
      ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown)
      : (gl.getParameter(gl.RENDERER) as unknown);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof r === 'string' && r ? r : null;
  } catch {
    return null;
  }
}

/**
 * Persisted override, honoured only if it was recorded on this renderer.
 * `storedRenderer === undefined` is the legacy plain-string value: always honoured.
 */
export function resolveOverride(
  preferCPU: boolean | undefined,
  storedRenderer: string | null | undefined,
  renderer: string | null,
): boolean | undefined {
  if (preferCPU === undefined) return undefined;
  if (storedRenderer !== undefined && storedRenderer !== renderer) return undefined;
  return preferCPU;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** CPU must beat GPU's median latency by this factor to win. */
export const CPU_WIN_RATIO = 0.8;
export const BENCH_GPU_WARMUP = 3;
export const BENCH_GPU_FRAMES = 20;
export const BENCH_CPU_WARMUP = 2;
export const BENCH_CPU_FRAMES = 10;

/** Pure decision: CPU only if its median is < ratio x GPU's median. */
export function chooseFaster(
  gpuMs: readonly number[],
  cpuMs: readonly number[],
  ratio = CPU_WIN_RATIO,
): Delegate {
  if (gpuMs.length === 0 || cpuMs.length === 0) return 'GPU';
  const g = median(gpuMs);
  const c = median(cpuMs);
  if (!Number.isFinite(g) || !Number.isFinite(c)) return 'GPU';
  return c < ratio * g ? 'CPU' : 'GPU';
}

/** Runtime GPU sanity watch: how long GPU has gone without finding any face. */
export interface GpuWatch {
  frames: number;
  firstT: number | null;
  lastT: number;
  anyFace: boolean;
  attempted: boolean;
}

export const GPU_CHECK_MIN_FRAMES = 45;
export const GPU_CHECK_MIN_MS = 3000;

export function newGpuWatch(): GpuWatch {
  return { frames: 0, firstT: null, lastT: 0, anyFace: false, attempted: false };
}

/** Record one GPU frame's outcome (mutates and returns `w`). */
export function recordGpuFrame(w: GpuWatch, t: number, face: boolean): GpuWatch {
  w.frames++;
  if (w.firstT === null) w.firstT = t;
  w.lastT = t;
  if (face) w.anyFace = true;
  return w;
}

/**
 * True once GPU has processed >= 45 frames AND >= 3 s of `t` timeline with
 * no face at all, and the CPU retry hasn't been attempted yet.
 */
export function shouldTryCpuFallback(
  w: GpuWatch,
  minFrames = GPU_CHECK_MIN_FRAMES,
  minMs = GPU_CHECK_MIN_MS,
): boolean {
  return (
    !w.attempted &&
    !w.anyFace &&
    w.firstT !== null &&
    w.frames >= minFrames &&
    w.lastT - w.firstT >= minMs
  );
}

const LUMA_W = 64;
const LUMA_H = 48;
const FACE_W = 32;
const FACE_H = 32;
const EYE_W = 48;
const EYE_H = 24;

interface LumaStats {
  mean: number;
  over245: number;
}

function makeSamplers() {
  const canvas = new OffscreenCanvas(LUMA_W, LUMA_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const stats = (w: number, h: number): LumaStats => {
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0;
    let over = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const y = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      sum += y;
      if (y > CFG.glareLumaCut) over++;
    }
    return { mean: sum / n, over245: over / n };
  };
  return {
    // Whole frame at fixed size.
    frame(bitmap: ImageBitmap): LumaStats {
      ctx.drawImage(bitmap, 0, 0, LUMA_W, LUMA_H);
      return stats(LUMA_W, LUMA_H);
    },
    // A normalized region at a chosen resolution.
    region(bitmap: ImageBitmap, box: NormBox, w: number, h: number): LumaStats {
      const [x0, y0, x1, y1] = box;
      const sx = x0 * bitmap.width;
      const sy = y0 * bitmap.height;
      const sw = Math.max(1, (x1 - x0) * bitmap.width);
      const sh = Math.max(1, (y1 - y0) * bitmap.height);
      if (canvas.width < w || canvas.height < h) {
        canvas.width = Math.max(canvas.width, w);
        canvas.height = Math.max(canvas.height, h);
      }
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
      return stats(w, h);
    },
  };
}

async function createLandmarker(
  wasmBase: string,
  modelUrl: string,
  delegate: Delegate,
): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

export async function createVisionEngine(
  wasmBase: string,
  modelUrl: string,
  opts: VisionEngineOptions = {},
): Promise<VisionEngine> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const renderer = probeWebGLRenderer();
  const software = isSoftwareRenderer(renderer);
  const preferCPU = resolveOverride(opts.preferCPU, opts.overrideRenderer, renderer);
  const first = pickInitialDelegate(ua, preferCPU, software);
  const second: Delegate = first === 'GPU' ? 'CPU' : 'GPU';
  let landmarker: FaceLandmarker;
  let delegate: Delegate = first;
  try {
    landmarker = await createLandmarker(wasmBase, modelUrl, first);
  } catch {
    delegate = second;
    landmarker = await createLandmarker(wasmBase, modelUrl, second);
  }

  const sampler = makeSamplers();
  let lastT = -1;
  const watch = newGpuWatch();
  const now = () => performance.now();

  const hasFace = (res: FaceLandmarkerResult) => (res.faceLandmarks?.[0]?.length ?? 0) >= 478;

  // At most one CPU landmarker is ever created per engine. It serves the
  // startup speed benchmark and/or the no-face sanity fallback.
  let cpuCreateAttempted = false;
  /** CPU instance kept after a GPU-wins benchmark that saw no face yet, for the no-face fallback. */
  let spareCpu: FaceLandmarker | null = null;

  async function getCpu(): Promise<FaceLandmarker | null> {
    if (spareCpu) {
      const c = spareCpu;
      spareCpu = null;
      return c;
    }
    if (cpuCreateAttempted) return null;
    cpuCreateAttempted = true;
    try {
      return await createLandmarker(wasmBase, modelUrl, 'CPU');
    } catch {
      return null;
    }
  }

  function adoptCpu(cpu: FaceLandmarker): void {
    landmarker.close();
    landmarker = cpu;
    delegate = 'CPU';
    watch.attempted = true;
  }

  // Startup speed benchmark: only when GPU was picked automatically on a
  // hardware renderer (no override) and GPU init actually succeeded.
  const bench: {
    phase: 'gpu' | 'cpu' | 'off';
    n: number;
    gpuMs: number[];
    cpuMs: number[];
    cpu: FaceLandmarker | null;
    cpuFace: boolean;
  } = {
    phase: preferCPU === undefined && !software && first === 'GPU' && delegate === 'GPU' ? 'gpu' : 'off',
    n: 0,
    gpuMs: [],
    cpuMs: [],
    cpu: null,
    cpuFace: false,
  };

  /** Re-run `bitmap` on the CPU landmarker; adopt it only if it finds a face. */
  async function tryCpu(bitmap: ImageBitmap, ts: number): Promise<FaceLandmarkerResult | null> {
    watch.attempted = true;
    const cpu = await getCpu();
    if (!cpu) return null;
    try {
      // Fresh (or idle spare) instance: its own timestamp sequence.
      const res = cpu.detectForVideo(bitmap, ts);
      if (hasFace(res)) {
        adoptCpu(cpu);
        return res;
      }
    } catch {
      /* fall through: stay on GPU */
    }
    cpu.close();
    return null;
  }

  return {
    get delegate() {
      return delegate;
    },
    renderer,
    software,
    async processFrame(bitmap, t) {
      const frameLuma = sampler.frame(bitmap).mean;
      const ts = Math.max(t, lastT + 1); // detectForVideo needs strictly increasing timestamps
      lastT = ts;
      let switchedDelegate: 'CPU' | undefined;
      let switchReason: SwitchReason | undefined;
      let timing: DelegateTiming | undefined;

      const t0 = now();
      let res = landmarker.detectForVideo(bitmap, ts);
      const gpuDt = now() - t0;

      if (bench.phase === 'gpu') {
        bench.n++;
        if (bench.n > BENCH_GPU_WARMUP) bench.gpuMs.push(gpuDt);
      } else if (bench.phase === 'cpu' && bench.cpu) {
        // Run CPU alongside for timing; the GPU result is what's returned.
        try {
          const c0 = now();
          const cr = bench.cpu.detectForVideo(bitmap, ts);
          const cpuDt = now() - c0;
          bench.n++;
          if (bench.n > BENCH_CPU_WARMUP) bench.cpuMs.push(cpuDt);
          if (hasFace(cr)) bench.cpuFace = true;
        } catch {
          bench.cpu.close();
          bench.cpu = null;
          bench.phase = 'off';
        }
      }

      if (delegate === 'GPU' && !watch.attempted && !watch.anyFace) {
        recordGpuFrame(watch, t, hasFace(res));
      }

      if (bench.phase === 'gpu' && bench.gpuMs.length >= BENCH_GPU_FRAMES) {
        const cpu = await getCpu();
        bench.cpu = cpu;
        bench.n = 0;
        bench.phase = cpu ? 'cpu' : 'off';
      } else if (bench.phase === 'cpu' && bench.cpu && bench.cpuMs.length >= BENCH_CPU_FRAMES) {
        const chose = chooseFaster(bench.gpuMs, bench.cpuMs);
        timing = {
          gpuMedianMs: median(bench.gpuMs),
          cpuMedianMs: median(bench.cpuMs),
          gpuSamples: bench.gpuMs.length,
          cpuSamples: bench.cpuMs.length,
          chose,
        };
        const cpu = bench.cpu;
        bench.cpu = null;
        bench.phase = 'off';
        if (chose === 'CPU') {
          adoptCpu(cpu);
          switchedDelegate = 'CPU';
          switchReason = 'faster';
        } else if (!watch.anyFace && bench.cpuFace) {
          // GPU is faster but blind while CPU sees a face: the sanity fallback, early.
          adoptCpu(cpu);
          switchedDelegate = 'CPU';
          switchReason = 'no-face';
        } else if (!watch.anyFace) {
          spareCpu = cpu; // nobody saw a face yet: keep for the no-face fallback
        } else {
          cpu.close();
        }
      }

      if (spareCpu && (watch.anyFace || delegate !== 'GPU')) {
        spareCpu.close();
        spareCpu = null;
      }

      if (
        bench.phase !== 'cpu' &&
        delegate === 'GPU' &&
        !watch.attempted &&
        !watch.anyFace &&
        shouldTryCpuFallback(watch)
      ) {
        const cpuRes = await tryCpu(bitmap, ts);
        bench.phase = 'off';
        if (cpuRes) {
          res = cpuRes;
          switchedDelegate = 'CPU';
          switchReason = 'no-face';
        }
      }

      const lm = res.faceLandmarks?.[0];
      let faceLuma = 0;
      const glare: [number, number] = [0, 0];
      if (lm && lm.length >= 478) {
        faceLuma = sampler.region(bitmap, faceBox(lm), FACE_W, FACE_H).mean;
        glare[0] = sampler.region(bitmap, eyeBox(lm, EYE_CONTOUR_R, 0.25, 0.6), EYE_W, EYE_H).over245;
        glare[1] = sampler.region(bitmap, eyeBox(lm, EYE_CONTOUR_L, 0.25, 0.6), EYE_W, EYE_H).over245;
      }
      const f = computeFrameFeatures(res, t, bitmap.width, bitmap.height, frameLuma, {
        faceLuma,
        glare,
      });
      const out: FrameResult = { f };
      if (switchedDelegate) {
        out.switchedDelegate = switchedDelegate;
        out.switchReason = switchReason;
      }
      if (timing) out.timing = timing;
      return out;
    },
    close() {
      landmarker.close();
      bench.cpu?.close();
      bench.cpu = null;
      spareCpu?.close();
      spareCpu = null;
    },
  };
}
