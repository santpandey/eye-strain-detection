import type { VisionEngine } from './engine';
import type {
  DelegateTiming,
  FrameFeatures,
  SwitchReason,
  WorkerInMessage,
  WorkerOutMessage,
} from './types';
import { CFG } from '../analysis/config';

/** File mode: playbackRate before the first throughput estimate. */
const FILE_INITIAL_RATE = 0.5;
/** File mode: how often the playback rate controller runs (wall-clock ms). */
const RATE_INTERVAL_MS = 500;
/** EMA smoothing for per-frame processing time. */
const EMA_ALPHA = 0.2;
/** Ignore the first result(s): they include model warm-up / shader compile. */
const WARMUP_RESULTS = 2;
/** Used when the video's native frame rate can't be estimated yet. */
const FALLBACK_VIDEO_FPS = 30;

type VideoWithPitch = HTMLVideoElement & {
  preservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

const base = import.meta.env.BASE_URL;
const WASM_BASE = `${base}mediapipe/wasm`;
const MODEL_URL = `${base}models/face_landmarker.task`;
/**
 * localStorage key for a persisted delegate override. Value is JSON
 * `{delegate, renderer, at, reason?}`; the legacy plain 'CPU' | 'GPU' string
 * is still accepted (and always honoured).
 */
export const DELEGATE_KEY = 'eyefd.delegate';

type Delegate = 'GPU' | 'CPU';

export interface StoredDelegate {
  delegate: Delegate;
  /** Renderer the choice was made on; undefined = legacy plain string (renderer-agnostic). */
  renderer?: string | null;
  at?: string;
  reason?: SwitchReason;
}

/** Parse the stored override; undefined if absent or malformed. */
export function parseStoredDelegate(raw: string | null): StoredDelegate | undefined {
  if (raw === 'CPU' || raw === 'GPU') return { delegate: raw };
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<StoredDelegate> | null;
    if (!v || (v.delegate !== 'CPU' && v.delegate !== 'GPU')) return undefined;
    return {
      delegate: v.delegate,
      renderer: typeof v.renderer === 'string' ? v.renderer : null,
      at: typeof v.at === 'string' ? v.at : undefined,
      reason: v.reason,
    };
  } catch {
    return undefined;
  }
}

function readDelegateOverride(): StoredDelegate | undefined {
  try {
    return parseStoredDelegate(localStorage.getItem(DELEGATE_KEY));
  } catch {
    return undefined;
  }
}

function persistDelegate(d: Delegate, renderer: string | null, reason?: SwitchReason): void {
  try {
    const v: StoredDelegate = { delegate: d, renderer, at: new Date().toISOString() };
    if (reason) v.reason = reason;
    localStorage.setItem(DELEGATE_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: switch still applies for this session */
  }
}

export type FeatureHandler = (f: FrameFeatures) => void;

/** Friendly message for a getUserMedia/camera-start failure. */
export function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was denied. Allow camera permission in your browser, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotSupportedError') {
    return 'No usable camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Your camera is busy — another app may be using it. Close it and retry.';
  }
  return e instanceof Error ? e.message : 'Something went wrong starting the camera.';
}

interface Backend {
  delegate: 'GPU' | 'CPU';
  send(bitmap: ImageBitmap, t: number): void;
  close(): void;
}

/**
 * Main-thread wrapper: owns the camera, the frame callback loop and the
 * one-frame-in-flight backpressure. Detection runs in a Web Worker when
 * possible and falls back to the main thread behind the same interface.
 */
export class VisionClient {
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private engine: VisionEngine | null = null;
  private backend: Backend | null = null;
  private inFlight = false;
  private running = false;
  /** Bumped per requestCamera and per releaseCamera — a request that resolves
   *  after being superseded releases its own tracks instead of assigning. */
  private requestGen = 0;
  /** Shared init in flight, so concurrent callers don't init twice. */
  private initPromise: Promise<Delegate> | null = null;
  private rafId = 0;
  private rvfcId = 0;
  private objectUrl: string | null = null;
  /** Whether frames come from the camera or a local video file. */
  source: 'camera' | 'file' = 'camera';
  /** Where inference runs: worker or main-thread fallback. */
  backendKind: 'worker' | 'main' | null = null;
  onFeatures: FeatureHandler | null = null;
  onError: ((message: string) => void) | null = null;
  /** Called when the engine switches delegate at runtime (GPU -> CPU sanity fallback). */
  onDelegateChange: ((d: Delegate) => void) | null = null;
  delegate: Delegate | null = null;
  /** WebGL renderer string reported by the engine (null: unknown / no WebGL). */
  renderer: string | null = null;
  /** True when WebGL is software-rendered or unavailable (engine defaults to CPU). */
  softwareGL = false;
  /** Startup GPU-vs-CPU benchmark result, once it has run (dev trace). */
  delegateTiming: DelegateTiming | null = null;
  /**
   * File mode: current video playbackRate. Playback is slowed so the pipeline
   * processes ≥ CFG.fileTargetFps frames per media-second regardless of device
   * speed. Always 1 for the camera.
   */
  playbackRate = 1;
  /** File mode: EMA of sustainable processing throughput (frames / wall-clock s); 0 = unknown. */
  throughputFps = 0;

  // Adaptive playback state (file mode only).
  private dispatchWall = 0; // performance.now() when the in-flight frame was dispatched
  private emaFrameMs = 0; // EMA of dispatch→result wall time per frame
  private resultCount = 0;
  private rateTimer = 0;
  private fpsProbe: { frames: number; media: number } | null = null; // rVFC baseline
  private videoFps = 0; // estimated native frame rate of the file; 0 = unknown

  async requestCamera(video: HTMLVideoElement): Promise<void> {
    const g = ++this.requestGen;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    if (g !== this.requestGen) {
      // Superseded by a newer requestCamera/releaseCamera while getUserMedia
      // was pending — release the tracks here so nothing leaks.
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Camera request was superseded.');
    }
    // Taking over from a stale stream (aborted earlier request): stop its
    // tracks so the camera can't stay on through a dead reference.
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.video && this.video !== video) this.video.srcObject = null;
    this.stream = stream;
    this.video = video;
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.source = 'camera';
  }

  /** Play a local video file through the same pipeline. Nothing is uploaded. */
  async useFile(video: HTMLVideoElement, file: File): Promise<void> {
    this.revokeObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.video = video;
    video.srcObject = null;
    video.src = this.objectUrl;
    video.muted = true;
    video.playsInline = true;
    // Audio is muted, so pitch correction is irrelevant; disable it so the
    // browser doesn't time-stretch audio (or mute/limit it) at low rates.
    const v = video as VideoWithPitch;
    v.preservesPitch = false;
    v.mozPreservesPitch = false;
    v.webkitPreservesPitch = false;
    this.resetAdaptive();
    // Set both: loading a new src resets playbackRate to defaultPlaybackRate.
    video.defaultPlaybackRate = FILE_INITIAL_RATE;
    video.playbackRate = FILE_INITIAL_RATE;
    this.playbackRate = FILE_INITIAL_RATE;
    this.source = 'file';
    // Stay paused at t=0 until the caller resumes once the pipeline is ready,
    // so the start of the clip isn't skipped while the model loads.
    await new Promise<void>((resolve) => {
      if (video.readyState >= 1) resolve();
      else video.addEventListener('loadeddata', () => resolve(), { once: true });
    });
    video.pause();
    video.currentTime = 0;
  }

  /** File mode: begin playback after init + capture start. */
  async play(): Promise<void> {
    if (this.video) await this.video.play();
  }

  private resetAdaptive(): void {
    this.dispatchWall = 0;
    this.emaFrameMs = 0;
    this.resultCount = 0;
    this.throughputFps = 0;
    this.fpsProbe = null;
    this.videoFps = 0;
  }

  /** Called for every successful result from either backend. */
  private handleResult(f: FrameFeatures): void {
    if (this.source === 'file' && this.dispatchWall > 0) {
      const dt = performance.now() - this.dispatchWall;
      this.dispatchWall = 0;
      this.resultCount++;
      if (this.resultCount > WARMUP_RESULTS && dt > 0) {
        this.emaFrameMs =
          this.emaFrameMs === 0 ? dt : this.emaFrameMs + EMA_ALPHA * (dt - this.emaFrameMs);
        // Throughput the 1-frame-in-flight pipeline can sustain. Measured as
        // busy time per frame rather than results/s, because results/s is
        // capped by how fast the (slowed) video delivers frames and would
        // never let the rate climb back up.
        this.throughputFps = 1000 / this.emaFrameMs;
      }
    }
    this.onFeatures?.(f);
  }

  /** Track the file's native frame rate from rVFC metadata (presented frames per media-second). */
  private probeVideoFps(meta?: { mediaTime?: number; presentedFrames?: number }): void {
    if (meta?.mediaTime === undefined || meta.presentedFrames === undefined) return;
    if (!this.fpsProbe) {
      this.fpsProbe = { frames: meta.presentedFrames, media: meta.mediaTime };
      return;
    }
    const dMedia = meta.mediaTime - this.fpsProbe.media;
    const dFrames = meta.presentedFrames - this.fpsProbe.frames;
    if (dMedia < 0 || dFrames < 0) {
      this.fpsProbe = null; // seek / loop: start over
      return;
    }
    if (dMedia >= 1) {
      const fps = dFrames / dMedia;
      if (fps > 1 && fps < 240) this.videoFps = Math.max(this.videoFps, fps);
    }
  }

  /** File mode: retune playbackRate from the throughput estimate. */
  private updatePlaybackRate(): void {
    const video = this.video;
    if (!video || this.source !== 'file' || this.throughputFps <= 0) return;
    // A 30 fps clip can't yield more than 30 processed frames per media-second.
    // Only trust a clearly lower estimate (24/25 fps clips); small shortfalls
    // are more likely dropped presentations than the real frame rate.
    const native = this.videoFps || FALLBACK_VIDEO_FPS;
    const target = native < CFG.fileTargetFps * 0.9 ? native : CFG.fileTargetFps;
    const rate = Math.min(1, Math.max(CFG.filePlaybackMin, this.throughputFps / target));
    const rounded = Math.round(rate * 100) / 100;
    if (Math.abs(rounded - video.playbackRate) >= 0.02) {
      video.playbackRate = rounded;
    }
    this.playbackRate = video.playbackRate;
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** Initialise the landmarker, preferring a worker; falls back to main thread.
   *  Concurrent callers share one in-flight init; a failure is retried on the
   *  next call. Idempotent while a backend already exists. */
  async init(): Promise<Delegate> {
    this.initPromise ??= this.doInit().catch((e) => {
      this.initPromise = null;
      throw e;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<Delegate> {
    const override = readDelegateOverride();
    try {
      const backend = await this.initWorker(30_000, override);
      this.backend = backend;
      this.backendKind = 'worker';
      this.delegate = backend.delegate;
    } catch {
      // Module-worker / wasm loaders can fail in some environments; retry on
      // the main thread behind the same interface. Imported lazily so
      // tasks-vision stays out of the main bundle.
      const { createVisionEngine } = await import('./engine');
      const engine = await createVisionEngine(WASM_BASE, MODEL_URL, {
        preferCPU: override === undefined ? undefined : override.delegate === 'CPU',
        overrideRenderer: override?.renderer,
      });
      this.engine = engine;
      this.renderer = engine.renderer;
      this.softwareGL = engine.software;
      const q: { bitmap: ImageBitmap; t: number }[] = [];
      let busy = false;
      const pump = async () => {
        if (busy) return;
        const job = q.shift();
        if (!job) {
          this.inFlight = false;
          return;
        }
        busy = true;
        try {
          const { f, switchedDelegate, switchReason, timing } = await engine.processFrame(
            job.bitmap,
            job.t,
          );
          job.bitmap.close();
          if (timing) this.delegateTiming = timing;
          if (switchedDelegate) this.handleDelegateSwitch(switchedDelegate, switchReason);
          this.handleResult(f);
        } catch (e) {
          job.bitmap.close();
          this.onError?.(e instanceof Error ? e.message : String(e));
        } finally {
          busy = false;
          if (q.length === 0) this.inFlight = false;
          pump();
        }
      };
      this.backend = {
        delegate: engine.delegate,
        send: (bitmap, t) => {
          q.push({ bitmap, t });
          pump();
        },
        close: () => engine.close(),
      };
      this.backendKind = 'main';
      this.delegate = engine.delegate;
    }
    return this.delegate;
  }

  private handleDelegateSwitch(d: Delegate, reason?: SwitchReason): void {
    this.delegate = d;
    if (this.backend) this.backend.delegate = d;
    persistDelegate(d, this.renderer, reason);
    this.onDelegateChange?.(d);
  }

  private initWorker(timeoutMs: number, override: StoredDelegate | undefined): Promise<Backend> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      let pending = 0;
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('worker init timed out'));
      }, timeoutMs);
      worker.onmessage = (ev: MessageEvent<WorkerOutMessage>) => {
        const msg = ev.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.worker = worker;
          this.renderer = msg.renderer;
          this.softwareGL = msg.software;
          resolve({
            delegate: msg.delegate,
            send: (bitmap, t) => {
              pending++;
              worker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
            },
            close: () => worker.terminate(),
          });
        } else if (msg.type === 'result') {
          pending--;
          this.inFlight = pending > 0;
          if (msg.timing) this.delegateTiming = msg.timing;
          if (msg.switchedDelegate) this.handleDelegateSwitch(msg.switchedDelegate, msg.switchReason);
          this.handleResult(msg.f);
        } else if (msg.type === 'error') {
          if (pending > 0) pending--;
          this.inFlight = pending > 0;
          if (!this.backend) {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(msg.message));
          } else {
            this.onError?.(msg.message);
          }
        }
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(e.message || 'worker failed'));
      };
      const init: WorkerInMessage = { type: 'init', wasmBase: WASM_BASE, modelUrl: MODEL_URL };
      if (override) {
        init.delegate = override.delegate;
        if (override.renderer !== undefined) init.delegateRenderer = override.renderer;
      }
      worker.postMessage(init);
    });
  }

  /** Start the frame loop. At most one frame is in flight at a time. */
  start(): void {
    if (this.running || !this.video || !this.backend) return;
    this.running = true;
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, metadata?: FrameMeta) => void,
      ) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    type FrameMeta = { mediaTime?: number; presentedFrames?: number };
    if (this.source === 'file') {
      // Adaptive playback: keep ≥ fileTargetFps processed frames per
      // media-second by slowing the video to what the device can sustain.
      this.rateTimer = window.setInterval(() => this.updatePlaybackRate(), RATE_INTERVAL_MS);
    }
    const tick = (_now?: number, metadata?: FrameMeta) => {
      if (!this.running) return;
      if (this.source === 'file') this.probeVideoFps(metadata);
      if (!this.inFlight && video.readyState >= 2 && video.videoWidth > 0) {
        this.inFlight = true;
        this.dispatchWall = performance.now();
        // File sources use media-time so results line up with video time;
        // the camera keeps performance.now().
        const t =
          this.source === 'file'
            ? (metadata?.mediaTime ?? video.currentTime) * 1000
            : performance.now();
        createImageBitmap(video)
          .then((bitmap) => {
            this.backend?.send(bitmap, t);
          })
          .catch(() => {
            this.inFlight = false;
            this.dispatchWall = 0;
          });
      }
      schedule();
    };
    const schedule = () => {
      if (video.requestVideoFrameCallback) {
        this.rvfcId = video.requestVideoFrameCallback(tick);
      } else {
        this.rafId = requestAnimationFrame(tick);
      }
    };
    schedule();
  }

  stop(): void {
    this.running = false;
    if (this.video?.cancelVideoFrameCallback && this.rvfcId) {
      this.video.cancelVideoFrameCallback(this.rvfcId);
    }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.rateTimer) clearInterval(this.rateTimer);
    this.rvfcId = 0;
    this.rafId = 0;
    this.rateTimer = 0;
  }

  /**
   * Release the media source (camera tracks fully stopped → webcam LED off)
   * but keep the backend/worker/engine alive, so `requestCamera()` +
   * `start()` work again without re-init. Used by the background monitor
   * between windows. Safe to call multiple times.
   */
  releaseCamera(): void {
    this.requestGen++; // a still-pending requestCamera now resolves stale
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.revokeObjectUrl();
    if (this.video) {
      this.video.srcObject = null;
      this.video.defaultPlaybackRate = 1;
      this.video.playbackRate = 1;
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.inFlight = false;
  }

  /** Stop camera, loop and backend. Safe to call multiple times. */
  destroy(): void {
    this.releaseCamera();
    this.backend?.close();
    this.backend = null;
    this.worker = null;
    this.engine = null;
    this.initPromise = null;
    this.inFlight = false;
    this.delegate = null;
    this.renderer = null;
    this.softwareGL = false;
    this.delegateTiming = null;
    this.backendKind = null;
    this.source = 'camera';
    this.playbackRate = 1;
    this.resetAdaptive();
  }
}
