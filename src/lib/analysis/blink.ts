import type { FrameFeatures } from '../vision/types';
import { CFG } from './config';

export interface BlinkEvent {
  start: number;
  end: number;
  /** Blink duration (= closedMs). Used for meanBlinkMs / longClosure. */
  durationMs: number;
  /**
   * Time c ≥ rest + durationFrac·(peak − rest), interpolated; gaps capped at
   * dtCapMs. 0 ≤ closedMs ≤ spanMs + 2·dtCapMs.
   */
  closedMs: number;
  /** Detection start→end span (inflated by slow tails). Debug. */
  spanMs: number;
  peak: number;
  /** Local rest level of c the event was measured against. */
  rest: number;
  complete: boolean; // peak >= peakComplete (absolute)
  longClosure: boolean; // complete && closedMs > longClosureMs
  /** Time above the duration level before the peak (closing phase). */
  closeMs: number;
  /** Time above the duration level after the peak (reopening phase). */
  reopenMs: number;
}

/** Knobs of the v2 (prominence + valley split) detector. Defaults from CFG. */
export interface BlinkParams {
  promStart: number;
  promEnd: number;
  valleyDrop: number;
  riseAgain: number;
  restWindowMs: number;
  restPercentile: number;
  settleMs: number;
  settleBand: number;
  gazeDownRise: number;
}

export function defaultBlinkParams(): BlinkParams {
  return {
    promStart: CFG.promStart,
    promEnd: CFG.promEnd,
    valleyDrop: CFG.valleyDrop,
    riseAgain: CFG.riseAgain,
    restWindowMs: CFG.restWindowMs,
    restPercentile: CFG.restPercentile,
    settleMs: CFG.settleMs,
    settleBand: CFG.settleBand,
    gazeDownRise: CFG.gazeDownRise,
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Level at which blink duration is measured: halfway (durationFrac) from rest to peak. */
export function durationLevelFor(peak: number, rest = 0): number {
  return rest + CFG.durationFrac * (peak - rest);
}

/**
 * Total time a piecewise-linear signal (samples in time order) spends at or
 * above `level`, with crossings linearly interpolated between frames.
 *
 * Intervals longer than `capMs` are gaps (quality-gated frames never reach the
 * detector): they contribute exactly `capMs` when both endpoints are ≥ level
 * and nothing otherwise — we don't interpolate a crossing across a gap.
 */
export function timeAtOrAbove(
  samples: { t: number; c: number }[],
  level: number,
  capMs: number = CFG.dtCapMs,
): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const aIn = a.c >= level;
    const bIn = b.c >= level;
    if (aIn && bIn) total += Math.min(dt, capMs);
    else if (aIn !== bIn && dt <= capMs) {
      const frac = (level - a.c) / (b.c - a.c); // crossing point in [0, 1]
      total += aIn ? frac * dt : (1 - frac) * dt;
    }
  }
  return total;
}

interface RecentSample {
  t: number;
  lookDown: number;
}

/** Closed event awaiting its post-event lookDown window before the gaze check. */
interface PendingEvent {
  ev: BlinkEvent;
  postLo: number;
  postEnd: number;
  /** Median rest lookDown at close time; NaN when no rest samples existed. */
  restLook: number;
}

interface EvSample {
  t: number;
  c: number;
  /** |cEarL − cEarR|, or NaN for the borrowed pre-event frame. */
  asym: number;
}

/** Optional per-frame debug record (eval tooling). */
export interface BlinkTraceSample {
  t: number;
  c: number;
  rest: number;
}

/**
 * Blink detector v2 over quality frames only. Callers pre-filter with
 * QualityCtx — dropped frames never reach push().
 *
 * Closure c ∈ [0,1] mixes the EAR drop vs a per-eye open baseline and the blink
 * blendshape. Events are found by *prominence* over a local rest level (a low
 * rolling percentile of c, frozen while an event is open), so a drifting
 * resting c (narrower eyes, resting blendshape) doesn't break start/end.
 * Rapid successive blinks whose valleys never return to rest are split at the
 * valley when c drops ≥ valleyDrop below the peak and rises ≥ riseAgain again.
 */
export class BlinkDetector {
  events: BlinkEvent[] = [];
  perclosMs = 0;
  qualityMs = 0;
  gazeDownDiscards = 0;
  asymmetricDiscards = 0;
  /** Set to an array to record (t, c, rest) for every pushed frame. */
  trace: BlinkTraceSample[] | null = null;

  readonly params: BlinkParams;

  private earHistL = new RollingWindow();
  private earHistR = new RollingWindow();
  private restHist = new RollingWindow();
  private lookHist = new RollingWindow(); // rest lookDown over non-event frames
  private rest = 0;
  private recent: RecentSample[] = []; // lookDown for pending post-event windows
  private pending: PendingEvent[] = [];
  private prevT: number | null = null;
  private firstQualityT: number | null = null;
  private lastQualityT: number | null = null;
  private prevSample: EvSample | null = null;

  // Open event state.
  private open = false;
  private openStart = 0;
  private openPeak = 0;
  private openRest = 0;
  private eventSamples: EvSample[] = [];
  /** Index into eventSamples of the lowest sample since the peak, or -1. */
  private valleyIdx = -1;

  constructor(params: Partial<BlinkParams> = {}) {
    this.params = { ...defaultBlinkParams(), ...params };
  }

  push(f: FrameFeatures): void {
    const p = this.params;
    if (this.firstQualityT === null) this.firstQualityT = f.t;
    this.lastQualityT = f.t;

    // Resolve deferred gaze checks first: a gap in the stream means the
    // post-event window can never be judged — accept pending events unchecked.
    const gap = this.prevT !== null && f.t - this.prevT > CFG.dtCapMs;
    this.recent.push({ t: f.t, lookDown: f.lookDown });
    const keepSince = f.t - (CFG.maxBlinkMs + CFG.gazePostOffsetMs + CFG.gazePostMs);
    while (this.recent.length && this.recent[0].t < keepSince) this.recent.shift();
    if (gap) this.flushPending();
    else this.drainPending(f.t);

    // Per-eye open baselines over the trailing window.
    this.earHistL.push(f.t, f.earL);
    this.earHistR.push(f.t, f.earR);
    const cutoff = f.t - CFG.earBaselineMs;
    this.earHistL.evictBefore(cutoff);
    this.earHistR.evictBefore(cutoff);
    const earOpenL =
      this.earHistL.size >= CFG.earBaselineMinSamples
        ? this.earHistL.percentile(90)
        : CFG.earOpenFallback;
    const earOpenR =
      this.earHistR.size >= CFG.earBaselineMinSamples
        ? this.earHistR.percentile(90)
        : CFG.earOpenFallback;
    const earOpen = (earOpenL + earOpenR) / 2;
    const ear = (f.earL + f.earR) / 2;

    const c = clamp01(
      (0.5 * clamp01(1 - ear / earOpen)) / CFG.earDropFrac + 0.5 * ((f.blinkL + f.blinkR) / 2),
    );
    const cEarL = clamp01((1 - f.earL / earOpenL) / CFG.earDropFrac);
    const cEarR = clamp01((1 - f.earR / earOpenR) / CFG.earDropFrac);

    const dt = this.prevT === null ? 0 : Math.min(f.t - this.prevT, CFG.dtCapMs);
    this.prevT = f.t;
    this.qualityMs += dt;
    if (c >= CFG.perclosLevel) this.perclosMs += dt;

    const sample: EvSample = { t: f.t, c, asym: Math.abs(cEarL - cEarR) };

    if (!this.open) {
      // Rest level from the trailing window of *previous* non-event frames.
      this.rest = this.restLevel(f.t);
      if (c - this.rest > p.promStart) {
        // Include the preceding frame so the up-crossing can be interpolated —
        // but only if it's adjacent; after a gated gap it may be seconds old.
        const prev = this.prevSample;
        const pre = prev && f.t - prev.t <= CFG.dtCapMs ? [{ ...prev, asym: NaN }] : [];
        this.openEvent(f.t, [...pre, sample]);
      } else {
        this.restHist.push(f.t, c);
        this.lookHist.push(f.t, f.lookDown);
        this.lookHist.evictBefore(f.t - CFG.gazeRestWindowMs);
      }
    } else {
      this.eventSamples.push(sample);
      const idx = this.eventSamples.length - 1;
      const v = this.valleyIdx >= 0 ? this.eventSamples[this.valleyIdx] : null;
      if (c - this.openRest < p.promEnd) {
        this.closeEvent(idx);
      } else if (this.settled(idx)) {
        // The lids reopened onto a new, higher resting level (eyes stay
        // narrower after the blink): close here and re-seed the rest level
        // from the settled stretch instead of waiting for c to return to the
        // frozen pre-blink rest.
        const settle = this.eventSamples.filter((s) => s.t >= f.t - p.settleMs);
        this.closeEvent(idx);
        this.restHist.clear();
        for (const s of settle) this.restHist.push(s.t, s.c);
        this.rest = this.restHist.percentile(p.restPercentile);
      } else if (v && v.c <= this.openPeak - p.valleyDrop && c >= v.c + p.riseAgain) {
        // Valley split: end here at the valley, reopen from the valley.
        const vi = this.valleyIdx;
        const tail = this.eventSamples.slice(vi);
        const rest = this.openRest;
        this.closeEvent(vi);
        this.openEvent(tail[0].t, tail, rest);
      } else if (c > this.openPeak) {
        this.openPeak = c;
        this.valleyIdx = -1;
      } else if (this.valleyIdx < 0 || c < this.eventSamples[this.valleyIdx].c) {
        this.valleyIdx = idx;
      }
      // Runaway guard: a sustained step in c (rest frozen) would otherwise
      // never close. Drop it and let the rest level absorb the new level.
      if (this.open && f.t - this.openStart > CFG.maxBlinkMs) {
        this.restHist.clear();
        for (const s of this.eventSamples) {
          if (s.t >= f.t - p.restWindowMs && Number.isFinite(s.asym)) this.restHist.push(s.t, s.c);
        }
        this.rest = this.restHist.percentile(p.restPercentile);
        this.resetOpen();
      }
    }
    this.prevSample = sample;
    this.trace?.push({ t: f.t, c, rest: this.open ? this.openRest : this.rest });
  }

  private restLevel(now: number): number {
    this.restHist.evictBefore(now - this.params.restWindowMs);
    if (this.restHist.size === 0) return 0;
    return this.restHist.percentile(this.params.restPercentile);
  }

  /**
   * Has the open event settled after its peak? c is well below the peak
   * (≤ peak − valleyDrop and ≤ the duration level) and has stayed within
   * settleBand for the last settleMs.
   */
  private settled(idx: number): boolean {
    const p = this.params;
    const ss = this.eventSamples;
    const now = ss[idx];
    const level = durationLevelFor(this.openPeak, this.openRest);
    if (now.c > this.openPeak - p.valleyDrop || now.c > level) return false;
    let lo = now.c;
    let hi = now.c;
    for (let i = idx - 1; i >= 0; i--) {
      const s = ss[i];
      if (!Number.isFinite(s.asym) || s.t < this.openStart) return false; // window not covered
      lo = Math.min(lo, s.c);
      hi = Math.max(hi, s.c);
      if (hi - lo > p.settleBand) return false;
      if (s.t <= now.t - p.settleMs) return true;
    }
    return false;
  }

  private openEvent(start: number, samples: EvSample[], rest = this.rest): void {
    this.open = true;
    this.openStart = start;
    this.openRest = rest;
    this.eventSamples = samples;
    this.openPeak = 0;
    this.valleyIdx = -1;
    // Peak/valley over the given samples (only frames from `start` on).
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t < start) continue;
      if (s.c > this.openPeak) {
        this.openPeak = s.c;
        this.valleyIdx = -1;
      } else if (this.valleyIdx < 0 || s.c < samples[this.valleyIdx].c) {
        this.valleyIdx = i;
      }
    }
  }

  private resetOpen(): void {
    this.open = false;
    this.openPeak = 0;
    this.eventSamples = [];
    this.valleyIdx = -1;
  }

  /** Close the open event at eventSamples[endIdx] (inclusive). */
  private closeEvent(endIdx: number): void {
    const p = this.params;
    const samples = this.eventSamples.slice(0, endIdx + 1);
    const start = this.openStart;
    const end = samples[samples.length - 1].t;
    const spanMs = end - start;
    const peak = this.openPeak;
    const rest = this.openRest;
    const level = durationLevelFor(peak, rest);
    // Invariant: 0 ≤ closedMs ≤ spanMs + 2·dtCapMs (pre-event interval + capped
    // gaps). Clamp defensively so a bad sample sequence can never leak out.
    const raw = timeAtOrAbove(samples, level, CFG.dtCapMs);
    const closedMs = Math.max(0, Math.min(raw, spanMs + 2 * CFG.dtCapMs));
    // Close/reopen phases: split the time above the duration level at the
    // first peak sample. Slow reopening is a documented drowsiness correlate.
    const peakIdx = samples.findIndex((s) => s.c >= peak);
    const closeMs = timeAtOrAbove(samples.slice(0, Math.max(1, peakIdx + 1)), level, CFG.dtCapMs);
    const reopenMs = timeAtOrAbove(
      samples.slice(Math.max(0, peakIdx)),
      level,
      CFG.dtCapMs,
    );
    const asyms = samples.filter((s) => Number.isFinite(s.asym) && s.t >= start).map((s) => s.asym);
    const asym = asyms.length ? asyms.reduce((a, b) => a + b, 0) / asyms.length : 0;
    this.resetOpen();

    const complete = peak >= CFG.peakComplete;
    if (spanMs > CFG.maxBlinkMs) return; // noise
    if (!complete && peak - rest < p.promStart) return; // noise
    if (asym > CFG.asymmetryMax) {
      this.asymmetricDiscards++;
      return;
    }
    const ev: BlinkEvent = {
      start,
      end,
      durationMs: closedMs,
      closedMs,
      spanMs,
      peak,
      rest,
      complete,
      longClosure: complete && closedMs > CFG.longClosureMs,
      closeMs,
      reopenMs,
    };
    // Gaze-down check is deferred: the decision needs lookDown from AFTER the
    // event (lid drop at onset reads as gaze-down, so a pre-event window is
    // confounded). Resolved by drainPending/flushPending.
    this.lookHist.evictBefore(end - CFG.gazeRestWindowMs);
    const restLook = this.lookHist.size > 0 ? this.lookHist.percentile(50) : NaN;
    this.pending.push({
      ev,
      postLo: end + CFG.gazePostOffsetMs,
      postEnd: end + CFG.gazePostOffsetMs + CFG.gazePostMs,
      restLook,
    });
  }

  /** Finalise pending events whose post-event lookDown window is covered. */
  private drainPending(now: number): void {
    while (this.pending.length && this.pending[0].postEnd <= now) {
      const p = this.pending.shift()!;
      // The next blink's lid drop reads as lookDown too, so if another event
      // opens inside (or just after) the window the gaze check is unobservable.
      // Pad: an event's detect-start lags its signal onset.
      const nextStart = this.open ? this.openStart : this.pending[0]?.ev.start;
      if (nextStart !== undefined && nextStart <= p.postEnd + CFG.gazeNeighborPadMs) {
        this.events.push(p.ev);
        continue;
      }
      const win: number[] = [];
      for (const s of this.recent) {
        if (s.t >= p.postLo && s.t <= p.postEnd) win.push(s.lookDown);
      }
      if (win.length === 0 || !Number.isFinite(p.restLook)) {
        this.events.push(p.ev); // window not observable → accept unchecked
        continue;
      }
      win.sort((a, b) => a - b);
      const med =
        win.length % 2 ? win[(win.length - 1) / 2] : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
      if (med - p.restLook > this.params.gazeDownRise) this.gazeDownDiscards++;
      else this.events.push(p.ev);
    }
  }

  /** Accept every pending event without the gaze check (gap / end of stream). */
  private flushPending(): void {
    for (const p of this.pending) this.events.push(p.ev);
    this.pending.length = 0;
  }

  /**
   * End of stream: close any open event at its last sample and release all
   * pending events (their post windows can't be covered) unchecked.
   */
  finish(): void {
    if (this.open) this.closeEvent(this.eventSamples.length - 1);
    this.flushPending();
  }

  /** Candidate events = accepted + the two tracked discard kinds. */
  get candidateCount(): number {
    return this.events.length + this.gazeDownDiscards + this.asymmetricDiscards;
  }

  get discardPct(): number {
    const n = this.candidateCount;
    return n > 0 ? ((this.gazeDownDiscards + this.asymmetricDiscards) / n) * 100 : 0;
  }

  get perclos(): number {
    return this.qualityMs > 0 ? this.perclosMs / this.qualityMs : 0;
  }

  /**
   * Gaps without a blink start: between consecutive event starts, plus the
   * leading gap (first quality frame → first event) and trailing gap
   * (last event start → last quality frame). With zero events the whole
   * quality span is one gap.
   */
  get interBlinkIntervals(): number[] {
    if (this.firstQualityT === null || this.lastQualityT === null) return [];
    if (this.events.length === 0) {
      return [this.lastQualityT - this.firstQualityT];
    }
    const starts = this.events.map((e) => e.start);
    const gaps = [starts[0] - this.firstQualityT];
    for (let i = 1; i < starts.length; i++) {
      gaps.push(starts[i] - starts[i - 1]);
    }
    gaps.push(this.lastQualityT - starts[starts.length - 1]);
    return gaps;
  }
}

/**
 * Time-windowed sample buffer with an always-sorted copy of the values, so a
 * percentile is O(1) and push/evict are a binary search + splice.
 */
class RollingWindow {
  private q: { t: number; v: number }[] = [];
  private head = 0;
  private sorted: number[] = [];

  get size(): number {
    return this.sorted.length;
  }

  push(t: number, v: number): void {
    this.q.push({ t, v });
    this.sorted.splice(lowerBound(this.sorted, v), 0, v);
  }

  evictBefore(cut: number): void {
    while (this.head < this.q.length && this.q[this.head].t < cut) {
      const v = this.q[this.head++].v;
      this.sorted.splice(lowerBound(this.sorted, v), 1);
    }
    if (this.head > 1024 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }

  clear(): void {
    this.q = [];
    this.head = 0;
    this.sorted = [];
  }

  /** Value at sorted index floor(pct/100 · n) (clamped); earOpenFallback if empty. */
  percentile(pct: number): number {
    const n = this.sorted.length;
    if (n === 0) return CFG.earOpenFallback;
    return this.sorted[Math.min(n - 1, Math.floor((pct / 100) * n))];
  }
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
