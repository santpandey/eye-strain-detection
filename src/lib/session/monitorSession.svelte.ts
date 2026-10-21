import { cameraErrorMessage, VisionClient } from '../vision/client';
import type { FrameFeatures } from '../vision/types';
import { QuickCheckAggregator, type QuickCheckResult } from '../analysis/session';
import { scoreAndLearn } from '../analysis/scoreSession';
import { CFG } from '../analysis/config';
import { saveSession } from '../storage/db';
import { isStaleModuleError } from '../stale';
import { isDev } from '../dev';
import { RoiTracker } from '../eyeRoi';
import { cameraBusy } from '../cameraLock';
import { fileSession } from './fileSession.svelte';
import { evaluateReminders, type Reminder, type ReminderKind } from '../analysis/monitorRules';
import { EXERCISES, type Exercise } from '../monitor/exercises';
import { sendNotification } from '../monitor/notify';

export type MonitorPhase = 'idle' | 'waiting' | 'arming' | 'capturing' | 'error';

const TICK_MS = 1000; // scheduler runs on a 1 s tick; all targets are absolute Date.now() times
const POSTPONE_BUSY_MS = 120_000; // camera busy (quick check / file) at window time → retry later
const RESUME_DELAY_MS = 5_000; // overdue window after the tab becomes visible again
const ARM_TIMEOUT_MS = 15_000; // the widget never mounted a <video> → give up on the window
const MONITOR_CFG_KEY = 'eyefd.monitorCfg'; // dev-only JSON overrides, see timing()

interface MonitorTiming {
  intervalMs: number;
  windowMs: number;
  breakEveryMs: number;
  snoozeMs: number;
  startupDelayMs: number;
}

/** CFG defaults, with dev-mode localStorage overrides for e2e/dev (short timers). */
function timing(): MonitorTiming {
  const base: MonitorTiming = {
    intervalMs: CFG.monitorIntervalMs,
    windowMs: CFG.monitorWindowMs,
    breakEveryMs: CFG.monitorBreakEveryMs,
    snoozeMs: CFG.monitorReminderSnoozeMs,
    startupDelayMs: CFG.monitorStartupDelayMs,
  };
  if (!isDev()) return base;
  try {
    const raw = localStorage.getItem(MONITOR_CFG_KEY);
    if (!raw) return base;
    const v = JSON.parse(raw) as Partial<MonitorTiming> | null;
    const num = (x: unknown, fallback: number) =>
      typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : fallback;
    return {
      intervalMs: num(v?.intervalMs, base.intervalMs),
      windowMs: num(v?.windowMs, base.windowMs),
      breakEveryMs: num(v?.breakEveryMs, base.breakEveryMs),
      snoozeMs: num(v?.snoozeMs, base.snoozeMs),
      startupDelayMs: num(v?.startupDelayMs, base.startupDelayMs),
    };
  } catch {
    return base;
  }
}

/**
 * Background monitor singleton (opt-in per session — never auto-starts).
 * Every ~15 min the camera turns on for ~1 min, frames run the usual
 * QualityCtx → BlinkDetector → QuickCheckAggregator pipeline, then the
 * camera is FULLY released (tracks stopped → LED off) until the next window.
 * The VisionClient backend/worker stays alive so later windows start fast.
 *
 * Windows never run while the page is hidden, and are postponed while a
 * Quick Check or file analysis holds the camera. Saved windows appear in
 * History with source 'monitor' and feed the personal baseline; low-
 * confidence windows are dropped silently (no save, no baseline learn).
 */
class MonitorSession {
  phase = $state<MonitorPhase>('idle');
  errorMsg = $state('');
  /** Countdown to the next window while 'waiting'. */
  nextWindowInMs = $state(0);
  /** Countdown while 'capturing'. */
  windowMsLeft = $state(0);
  /** clip-path CSS cropping the preview to the eye region ('' = full view). */
  roiCss = $state('');
  activeReminders = $state<Reminder[]>([]);
  activeExercise = $state<Exercise | null>(null);
  exerciseMsLeft = $state(0);
  /** Windows completed since start() — drives the rules' windowCount. */
  windowsDone = $state(0);

  private client = new VisionClient();
  private agg: QuickCheckAggregator | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private roiTracker = new RoiTracker();
  /** Bumped on start/stop so stale async continuations no-op. */
  private gen = 0;

  private tickId = 0;
  private nextWindowAt = 0; // absolute Date.now() target of the next window
  private windowEndAt = 0; // absolute Date.now() end of the current window
  private armingSince = 0;
  private exerciseEndAt = 0;
  private exerciseKind: ReminderKind | null = null;

  private monitorOnSince = 0;
  private lastBreakAt: number | null = null;
  private lastWindowResult: QuickCheckResult | null = null;
  private snoozedUntil: Partial<Record<ReminderKind, number>> = {};
  private hiddenPaused = false;
  private timingCfg = timing();

  /** Turn monitoring on (requires an explicit user action each session). */
  start(): void {
    if (this.phase !== 'idle' && this.phase !== 'error') return;
    this.gen++;
    this.timingCfg = timing();
    this.errorMsg = '';
    this.monitorOnSince = Date.now();
    this.lastBreakAt = null;
    this.lastWindowResult = null;
    this.windowsDone = 0;
    this.activeReminders = [];
    this.activeExercise = null;
    this.exerciseKind = null;
    this.snoozedUntil = {};
    this.hiddenPaused = false;
    this.roiTracker = new RoiTracker();
    this.roiCss = '';
    this.nextWindowAt = this.monitorOnSince + this.timingCfg.startupDelayMs;
    this.nextWindowInMs = this.timingCfg.startupDelayMs;
    this.windowMsLeft = 0;
    this.phase = 'waiting';
    document.addEventListener('visibilitychange', this.onVisibility);
    this.tickId = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** Full teardown: camera released, backend closed, back to 'idle'. */
  stop(): void {
    this.gen++;
    this.teardown();
    this.errorMsg = '';
    this.phase = 'idle';
  }

  /** Called by MonitorWidget once the <video> element is mounted. */
  attachVideo(el: HTMLVideoElement): void {
    if (this.videoEl === el) return;
    this.videoEl = el;
    void this.arm(el);
  }

  /** Called by MonitorWidget when the <video> element unmounts. */
  detachVideo(el: HTMLVideoElement): void {
    if (this.videoEl !== el) return;
    this.videoEl = null;
  }

  dismissReminder(id: string): void {
    const r = this.activeReminders.find((x) => x.id === id);
    if (!r) return;
    this.activeReminders = this.activeReminders.filter((x) => x.id !== id);
    this.snoozedUntil[r.kind] = Date.now() + this.timingCfg.snoozeMs;
  }

  startExercise(reminder: Reminder): void {
    const ex = reminder.exercise ? EXERCISES[reminder.exercise] : undefined;
    if (!ex) return;
    this.activeReminders = this.activeReminders.filter((x) => x.id !== reminder.id);
    this.activeExercise = ex;
    this.exerciseKind = reminder.kind;
    this.exerciseEndAt = Date.now() + ex.seconds * 1000;
    this.exerciseMsLeft = ex.seconds * 1000;
  }

  /** Done (auto or "Done"): counts as a break; snoozes the reminder that offered it. */
  finishExercise(): void {
    if (!this.activeExercise) return;
    if (this.exerciseKind) {
      this.snoozedUntil[this.exerciseKind] = Date.now() + this.timingCfg.snoozeMs;
    }
    this.lastBreakAt = Date.now();
    this.activeExercise = null;
    this.exerciseKind = null;
    this.exerciseMsLeft = 0;
  }

  skipExercise(): void {
    if (this.exerciseKind) {
      this.snoozedUntil[this.exerciseKind] = Date.now() + this.timingCfg.snoozeMs;
    }
    this.activeExercise = null;
    this.exerciseKind = null;
    this.exerciseMsLeft = 0;
  }

  /** Error chip dismiss → monitor stays off. */
  dismissError(): void {
    if (this.phase === 'error') {
      this.errorMsg = '';
      this.phase = 'idle';
    }
  }

  private teardown(): void {
    if (this.tickId) window.clearInterval(this.tickId);
    this.tickId = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.client.onFeatures = null;
    this.client.onError = null;
    this.client.destroy();
    this.agg = null;
    this.activeExercise = null;
    this.exerciseKind = null;
    this.activeReminders = [];
    this.exerciseMsLeft = 0;
    this.nextWindowInMs = 0;
    this.windowMsLeft = 0;
    this.hiddenPaused = false;
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === 'waiting') {
      this.nextWindowInMs = Math.max(0, this.nextWindowAt - now);
      if (!this.hiddenPaused && !document.hidden && now >= this.nextWindowAt) {
        this.onWindowDue(now);
      }
    } else if (this.phase === 'arming') {
      // The widget should mount a <video> right away; without it arm() can't run.
      if (!this.videoEl && now - this.armingSince > ARM_TIMEOUT_MS) {
        this.fail('Camera preview could not start.');
      }
    } else if (this.phase === 'capturing') {
      this.windowMsLeft = Math.max(0, this.windowEndAt - now);
      if (now >= this.windowEndAt) void this.endWindow();
    }
    if (this.activeExercise) {
      this.exerciseMsLeft = Math.max(0, this.exerciseEndAt - now);
      if (this.exerciseMsLeft <= 0) this.finishExercise();
    }
    this.refreshReminders(now);
  }

  private onWindowDue(now: number): void {
    // Never compete for the camera with a quick check or the file pipeline.
    if (fileSession.phase === 'analyzing' || cameraBusy()) {
      this.nextWindowAt = now + POSTPONE_BUSY_MS;
      return;
    }
    this.armingSince = now;
    this.phase = 'arming';
  }

  /**
   * Camera on → pipeline → camera off. Runs after the widget mounts the
   * <video>; the gen/alive checks drop stale continuations (stop/hidden).
   * Stale arms never touch the client's stream: whoever made this arm stale
   * already released it (releaseCamera bumps requestGen, so a still-pending
   * getUserMedia self-releases; a resolved stream was already stopped).
   */
  private async arm(el: HTMLVideoElement): Promise<void> {
    const g = this.gen;
    const alive = () => this.gen === g && this.phase === 'arming' && this.videoEl === el;
    try {
      await this.client.requestCamera(el);
      if (!alive()) return;
      if (!this.client.backendKind) {
        await this.client.init();
        if (!alive()) return;
      }
      this.client.onFeatures = (f) => this.onFeatures(f);
      this.client.onError = (m) => this.fail(m);
      const agg = new QuickCheckAggregator();
      agg.traceEnabled = isDev();
      agg.begin();
      this.agg = agg;
      this.roiTracker = new RoiTracker();
      this.roiCss = '';
      this.windowEndAt = Date.now() + this.timingCfg.windowMs;
      this.windowMsLeft = this.timingCfg.windowMs;
      this.client.start();
      this.phase = 'capturing';
    } catch (e) {
      if (!alive()) return;
      this.fail(isStaleModuleError(e) ? e : cameraErrorMessage(e));
    }
  }

  private onFeatures(f: FrameFeatures): void {
    const agg = this.agg;
    if (this.phase !== 'capturing' || !agg) return;
    agg.push(f);
    this.roiTracker.push(f);
    this.roiCss = this.roiTracker.css;
  }

  /** Window done: release the camera FIRST, then score/save and reschedule. */
  private async endWindow(): Promise<void> {
    const agg = this.agg;
    if (!agg || this.phase !== 'capturing') return;
    const g = this.gen;
    this.phase = 'waiting';
    this.windowMsLeft = 0;
    // Release before the awaits below: the LED goes off even if scoring is
    // slow, and nextWindowAt is set up front so a tick during the async part
    // can't fire a spurious extra window.
    this.client.releaseCamera();
    this.nextWindowAt = Date.now() + this.timingCfg.intervalMs;
    const r = agg.result('monitor');
    this.stashTrace(r); // reads client fields — run before they can be torn down
    this.agg = null;
    this.roiTracker = new RoiTracker();
    this.roiCss = '';
    this.windowsDone++;
    this.lastWindowResult = null;
    if (r.confidence !== 'low') {
      try {
        // Score vs the pre-update baseline, then learn, then save — same
        // ordering as the quick check / file flows.
        await scoreAndLearn(r);
        try {
          await saveSession(r);
        } catch {
          // Storage failure shouldn't take the monitor down.
        }
        if (this.gen === g) this.lastWindowResult = r;
      } catch {
        // Scoring failed → drop the window silently like a low-confidence one.
      }
    }
    if (this.gen !== g) return;
    this.refreshReminders(Date.now());
  }

  /**
   * Merge newly-due reminders into activeReminders: one pending per kind,
   * snoozed kinds stay quiet until their snooze elapses. In-app cards always
   * show; the OS notification is a no-op unless enabled in Settings.
   */
  private refreshReminders(now: number): void {
    if (this.phase === 'idle' || this.phase === 'error') return;
    const candidates = evaluateReminders({
      now,
      monitorOnSince: this.monitorOnSince,
      lastBreakAt: this.lastBreakAt,
      lastWindowResult: this.lastWindowResult,
      windowCount: this.windowsDone,
      breakEveryMs: this.timingCfg.breakEveryMs,
    });
    for (const c of candidates) {
      if (this.activeReminders.some((r) => r.kind === c.kind)) continue;
      if ((this.snoozedUntil[c.kind] ?? 0) > now) continue;
      this.activeReminders.push(c);
      sendNotification(c.title, c.body);
    }
  }

  /** Hard failure → camera released + monitor off, with a dismissible error chip. */
  private fail(e: unknown): void {
    this.stashTrace(); // dev: keep the partial trace on the error path too
    this.gen++;
    this.teardown();
    if (isStaleModuleError(e)) {
      this.errorMsg = 'The app was updated while this page was open — reload, then start the monitor again.';
    } else {
      this.errorMsg = e instanceof Error ? e.message : String(e);
    }
    this.phase = 'error';
  }

  /**
   * The camera must never run while the page is hidden: an in-flight window
   * is dropped (tracks stopped) and the cadence pauses. On becoming visible
   * again an overdue window runs after ~5 s, else the absolute target stands.
   */
  private onVisibility = (): void => {
    if (this.phase === 'idle' || this.phase === 'error') return;
    if (document.hidden) {
      this.hiddenPaused = true;
      if (this.phase === 'arming' || this.phase === 'capturing') {
        this.client.releaseCamera();
        this.agg = null;
        this.phase = 'waiting';
        this.nextWindowAt = 0; // overdue → fires ~RESUME_DELAY_MS after visible
      }
    } else if (this.hiddenPaused) {
      this.hiddenPaused = false;
      if (this.nextWindowAt <= Date.now()) {
        this.nextWindowAt = Date.now() + RESUME_DELAY_MS;
      }
    }
  };

  /** Same shape Check.svelte uses for camera traces, with source 'monitor'. */
  private stashTrace(r: QuickCheckResult | null = null): void {
    const agg = this.agg;
    if (!isDev() || !agg) return;
    (window as unknown as { __eyefdLastTrace?: unknown }).__eyefdLastTrace = {
      schema: 1,
      source: 'monitor',
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

export const monitor = new MonitorSession();
