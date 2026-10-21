import { VisionClient } from '../vision/client';
import type { FrameFeatures } from '../vision/types';
import { guidanceFor, type QualityVerdict } from '../analysis/quality';
import { QuickCheckAggregator, type QuickCheckResult } from '../analysis/session';
import { scoreAndLearn, type ScoreView } from '../analysis/scoreSession';
import { CFG } from '../analysis/config';
import { saveSession } from '../storage/db';
import { isStaleModuleError } from '../stale';
import { isDev } from '../dev';
import { RoiTracker } from '../eyeRoi';

export type FilePhase = 'idle' | 'analyzing' | 'done' | 'abstain' | 'error' | 'stale';

const CAPTURE_MS = CFG.captureMs;

/** `m:ss` clock for a seconds count. */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Human ETA for a seconds count (wall-clock, already rate-adjusted). */
export function etaLabel(s: number): string {
  if (s < 60) return `≈ ${Math.max(5, Math.round(s / 5) * 5)} s left`;
  return `≈ ${Math.round(s / 60)} min left`;
}

/**
 * Singleton that owns video-file analysis. The file is played through the
 * same VisionClient + QuickCheckAggregator pipeline the camera path uses, in
 * a <video> element hosted by MiniPlayer (mounted at app level so navigation
 * never tears the session down; display:none would break rVFC).
 *
 * Lifecycle: startFile(file) → phase 'analyzing' (video element may not be
 * mounted yet — attachVideo resolves the race via pendingFile) → 'done' /
 * 'abstain' / 'error' / 'stale' → reset() back to 'idle'.
 */
class FileSession {
  fileName = $state('');
  phase = $state<FilePhase>('idle');
  result = $state<QuickCheckResult | null>(null);
  /** Fatigue score + baseline context for the results card (null on abstain). */
  scoreView = $state<ScoreView | null>(null);
  errorMsg = $state('');
  delegate = $state('');

  // Progress HUD (mediaPos/mediaDur in seconds, usableMs in ms).
  mediaPos = $state(0);
  mediaDur = $state(0);
  usableMs = $state(0);
  blinks = $state(0);
  playRate = $state(1);
  paused = $state(false);
  pausedMs = $state(0); // cumulative gated time, for the framing tip
  /** clip-path CSS cropping the mini-player to the eye region ('' = full view). */
  roiCss = $state('');

  private lastVerdict = $state<QualityVerdict | null>(null);

  /** Why capture is currently gated (shown as "Paused — …"). */
  pauseReason = $derived(
    this.lastVerdict?.reasons.includes('noFace') || !this.lastVerdict
      ? 'Face not detected'
      : guidanceFor(this.lastVerdict, 'Face the camera'),
  );
  /** Wall-clock seconds left = remaining media time / playback rate. */
  etaS = $derived(
    this.mediaDur > 0 && this.playRate > 0
      ? Math.max(0, this.mediaDur - this.mediaPos) / this.playRate
      : 0,
  );
  etaText = $derived(this.etaS > 0 ? etaLabel(this.etaS) : '');
  slowed = $derived(this.playRate < 0.95);
  rateLabel = $derived(
    `${this.playRate < 0.1 ? this.playRate.toFixed(2) : this.playRate.toFixed(1)}×`,
  );
  /** Media progress 0–1 for the mini-player bar. */
  progress = $derived(
    this.mediaDur > 0 ? Math.min(1, this.mediaPos / this.mediaDur) : 0,
  );
  showFramingTip = $derived(this.pausedMs > 5000);

  private client = new VisionClient();
  private agg: QuickCheckAggregator | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private pendingFile: File | null = null;
  private prevCaptureT: number | null = null;
  private roiTracker = new RoiTracker();
  /** Bumped on every start/reset so stale async continuations no-op. */
  private gen = 0;

  /** Pick a new file. Restarts cleanly if a session is already running. */
  startFile(file: File): void {
    this.gen++;
    this.client.destroy();
    this.agg = null;
    this.fileName = file.name;
    this.result = null;
    this.scoreView = null;
    this.errorMsg = '';
    this.delegate = '';
    this.resetStats();
    this.pendingFile = file;
    this.phase = 'analyzing';
    this.maybeStart();
  }

  /** Called by MiniPlayer once the <video> element is mounted. */
  attachVideo(el: HTMLVideoElement): void {
    if (this.videoEl === el) return;
    this.videoEl = el;
    el.addEventListener('ended', this.onVideoEnded);
    this.maybeStart();
  }

  /** Called by MiniPlayer when the <video> element unmounts. */
  detachVideo(el: HTMLVideoElement): void {
    if (this.videoEl !== el) return;
    el.removeEventListener('ended', this.onVideoEnded);
    this.videoEl = null;
  }

  /** Cancel a running analysis or dismiss a finished one. */
  reset(): void {
    this.gen++;
    this.client.destroy();
    this.agg = null;
    this.pendingFile = null;
    this.phase = 'idle';
    this.result = null;
    this.scoreView = null;
    this.errorMsg = '';
    this.fileName = '';
    this.delegate = '';
    this.resetStats();
  }

  private resetStats(): void {
    this.mediaPos = 0;
    this.mediaDur = 0;
    this.usableMs = 0;
    this.blinks = 0;
    this.playRate = 1;
    this.paused = false;
    this.pausedMs = 0;
    this.lastVerdict = null;
    this.prevCaptureT = null;
    this.roiTracker = new RoiTracker();
    this.roiCss = '';
  }

  private maybeStart(): void {
    const file = this.pendingFile;
    const el = this.videoEl;
    if (!file || !el || this.phase !== 'analyzing') return;
    this.pendingFile = null;
    void this.runPipeline(el, file);
  }

  private async runPipeline(el: HTMLVideoElement, file: File): Promise<void> {
    const g = this.gen;
    const alive = () => this.gen === g && this.phase === 'analyzing' && this.videoEl === el;
    try {
      await this.client.useFile(el, file);
      if (!alive()) return;
      this.client.onDelegateChange = (d) => (this.delegate = d);
      this.delegate = await this.client.init();
      if (!alive()) return;
      this.client.onFeatures = (f) => this.onFeatures(f);
      this.client.onError = (m) => this.fail(m);
      this.client.start();
      await this.client.play();
      if (!alive()) return;
      this.beginCapture();
    } catch (e) {
      if (!alive()) return;
      this.fail(
        isStaleModuleError(e)
          ? e
          : 'Could not play that video file. Try a common format like MP4 or WebM.',
      );
    }
  }

  private beginCapture(): void {
    const agg = new QuickCheckAggregator();
    agg.traceEnabled = isDev();
    agg.begin();
    this.agg = agg;
    this.usableMs = 0;
    this.blinks = 0;
    this.pausedMs = 0;
    this.prevCaptureT = null;
    this.paused = false;
    this.playRate = this.client.playbackRate;
  }

  private onFeatures(f: FrameFeatures): void {
    const agg = this.agg;
    if (this.phase !== 'analyzing' || !agg) return;
    agg.push(f);
    this.roiTracker.push(f);
    this.roiCss = this.roiTracker.css;
    this.lastVerdict = agg.quality.last;
    this.usableMs = agg.detector.qualityMs;
    this.blinks = agg.detector.events.length;
    const ok = this.lastVerdict?.ok ?? false;
    if (!ok && this.prevCaptureT !== null) {
      // Cap per-frame dt so a stalled stream doesn't inflate the total.
      this.pausedMs += Math.min(500, Math.max(0, f.t - this.prevCaptureT));
    }
    this.paused = !ok;
    this.prevCaptureT = f.t;
    const el = this.videoEl;
    if (el) {
      this.mediaPos = el.currentTime || 0;
      const d = el.duration;
      this.mediaDur = Number.isFinite(d) ? d : 0;
    }
    this.playRate = this.client.playbackRate;
    if (this.usableMs >= CAPTURE_MS) void this.finish();
  }

  private onVideoEnded = (): void => {
    if (this.phase !== 'analyzing' || !this.agg) return;
    void this.finish();
  };

  private async finish(): Promise<void> {
    const agg = this.agg;
    if (!agg || this.phase !== 'analyzing') return;
    const r = agg.result('file');
    this.result = r;
    this.stashTrace(r); // reads client fields — must run before destroy()
    this.client.destroy();
    if (r.confidence === 'low') {
      this.phase = 'abstain';
      return; // abstain = not saved, no baseline update
    }
    // Score vs the pre-update baseline, then learn, then save — so the stored
    // record carries fatigueScore and this session doesn't anchor its own score.
    this.scoreView = await scoreAndLearn(r);
    try {
      await saveSession(r);
    } catch {
      // Storage failure shouldn't block the results view.
    }
    this.phase = 'done';
  }

  private fail(e: unknown): void {
    this.stashTrace(); // dev: keep partial trace on the error path too
    this.client.destroy();
    if (isStaleModuleError(e)) {
      this.phase = 'stale';
    } else {
      this.errorMsg = e instanceof Error ? e.message : String(e);
      this.phase = 'error';
    }
  }

  /** Same shape Check.svelte uses for camera traces, with source 'file'. */
  private stashTrace(r: QuickCheckResult | null = null): void {
    const agg = this.agg;
    if (!isDev() || !agg) return;
    (window as unknown as { __eyefdLastTrace?: unknown }).__eyefdLastTrace = {
      schema: 1,
      source: 'file',
      startedAt: agg.startedAt ?? '',
      frames: agg.traceFrames,
      diag: agg.traceDiag,
      events: agg.detector.events,
      delegate: this.client.delegate,
      backend: this.client.backendKind,
      renderer: this.client.renderer,
      delegateTiming: this.client.delegateTiming,
      result: r,
    };
  }
}

export const fileSession = new FileSession();
