"""BlinkDetector: closure state machine, PERCLOS, discards.

Keep in sync with src/lib/analysis/blink.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import dataclass, field

from .config import CFG
from .features import FrameFeatures

NAN = float("nan")


@dataclass
class BlinkEvent:
    start: float
    end: float
    # Blink duration (= closedMs). Used for meanBlinkMs / longClosure.
    durationMs: float
    # Time c ≥ rest + durationFrac·(peak − rest), interpolated; gaps capped at
    # dtCapMs. 0 ≤ closedMs ≤ spanMs + 2·dtCapMs.
    closedMs: float
    # Detection start→end span (inflated by slow tails). Debug.
    spanMs: float
    peak: float
    # Local rest level of c the event was measured against.
    rest: float
    complete: bool  # peak >= peakComplete (absolute)
    longClosure: bool  # complete && closedMs > longClosureMs
    # Time above the duration level before the peak (closing phase).
    closeMs: float
    # Time above the duration level after the peak (reopening phase).
    reopenMs: float

    def to_dict(self) -> dict:
        return {
            "start": self.start,
            "end": self.end,
            "durationMs": self.durationMs,
            "closedMs": self.closedMs,
            "spanMs": self.spanMs,
            "peak": self.peak,
            "rest": self.rest,
            "complete": self.complete,
            "longClosure": self.longClosure,
            "closeMs": self.closeMs,
            "reopenMs": self.reopenMs,
        }


def default_blink_params() -> dict:
    """Knobs of the v2 (prominence + valley split) detector. Defaults from CFG."""
    return {
        "promStart": CFG.promStart,
        "promEnd": CFG.promEnd,
        "valleyDrop": CFG.valleyDrop,
        "riseAgain": CFG.riseAgain,
        "restWindowMs": CFG.restWindowMs,
        "restPercentile": CFG.restPercentile,
        "settleMs": CFG.settleMs,
        "settleBand": CFG.settleBand,
        "gazeDownRise": CFG.gazeDownRise,
    }


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def duration_level_for(peak: float, rest: float = 0.0) -> float:
    """Level at which blink duration is measured: halfway (durationFrac) from rest to peak."""
    return rest + CFG.durationFrac * (peak - rest)


def time_at_or_above(samples: list, level: float, cap_ms: float = CFG.dtCapMs) -> float:
    """Total time a piecewise-linear signal (samples in time order) spends at or
    above `level`, with crossings linearly interpolated between frames.

    Intervals longer than `cap_ms` are gaps (quality-gated frames never reach the
    detector): they contribute exactly `cap_ms` when both endpoints are ≥ level
    and nothing otherwise — we don't interpolate a crossing across a gap.

    `samples` is a list of (t, c) pairs or dicts/objects with .t/.c.
    """
    total = 0.0
    for i in range(1, len(samples)):
        a = samples[i - 1]
        b = samples[i]
        at, ac = (a["t"], a["c"]) if isinstance(a, dict) else (a.t, a.c)
        bt, bc = (b["t"], b["c"]) if isinstance(b, dict) else (b.t, b.c)
        dt = bt - at
        if dt <= 0:
            continue
        a_in = ac >= level
        b_in = bc >= level
        if a_in and b_in:
            total += min(dt, cap_ms)
        elif a_in != b_in and dt <= cap_ms:
            frac = (level - ac) / (bc - ac)  # crossing point in [0, 1]
            total += frac * dt if a_in else (1 - frac) * dt
    return total


@dataclass
class _EvSample:
    t: float
    c: float
    # |cEarL − cEarR|, or NaN for the borrowed pre-event frame.
    asym: float


class BlinkDetector:
    """Blink detector v2 over quality frames only. Callers pre-filter with
    QualityCtx — dropped frames never reach push().

    Closure c ∈ [0,1] mixes the EAR drop vs a per-eye open baseline and the blink
    blendshape. Events are found by *prominence* over a local rest level (a low
    rolling percentile of c, frozen while an event is open), so a drifting
    resting c (narrower eyes, resting blendshape) doesn't break start/end.
    Rapid successive blinks whose valleys never return to rest are split at the
    valley when c drops ≥ valleyDrop below the peak and rises ≥ riseAgain again.
    """

    def __init__(self, params: dict | None = None) -> None:
        self.events: list = []
        self.perclos_ms = 0.0
        self.quality_ms = 0.0
        self.gaze_down_discards = 0
        self.asymmetric_discards = 0
        # Set to a list to record (t, c, rest) for every pushed frame.
        self.trace: list | None = None

        self.params = default_blink_params()
        if params:
            self.params.update(params)

        self._ear_hist_l = _RollingWindow()
        self._ear_hist_r = _RollingWindow()
        self._rest_hist = _RollingWindow()
        self._look_hist = _RollingWindow()  # rest lookDown over non-event frames
        self._rest = 0.0
        self._recent: list = []  # {"t":…, "lookDown":…} for pending post windows
        self._pending: list = []  # {"ev":…, "postLo":…, "postEnd":…, "restLook":…}
        self._prev_t = None
        self._first_quality_t = None
        self._last_quality_t = None
        self._prev_sample: _EvSample | None = None

        # Open event state.
        self._open = False
        self._open_start = 0.0
        self._open_peak = 0.0
        self._open_rest = 0.0
        self._event_samples: list = []
        # Index into event_samples of the lowest sample since the peak, or -1.
        self._valley_idx = -1

    def push(self, f: FrameFeatures) -> None:
        p = self.params
        if self._first_quality_t is None:
            self._first_quality_t = f.t
        self._last_quality_t = f.t

        # Resolve deferred gaze checks first: a gap in the stream means the
        # post-event window can never be judged — accept pending events unchecked.
        gap = self._prev_t is not None and f.t - self._prev_t > CFG.dtCapMs
        self._recent.append({"t": f.t, "lookDown": f.lookDown})
        keep_since = f.t - (CFG.maxBlinkMs + CFG.gazePostOffsetMs + CFG.gazePostMs)
        while self._recent and self._recent[0]["t"] < keep_since:
            self._recent.pop(0)
        if gap:
            self._flush_pending()
        else:
            self._drain_pending(f.t)

        # Per-eye open baselines over the trailing window.
        self._ear_hist_l.push(f.t, f.earL)
        self._ear_hist_r.push(f.t, f.earR)
        cutoff = f.t - CFG.earBaselineMs
        self._ear_hist_l.evict_before(cutoff)
        self._ear_hist_r.evict_before(cutoff)
        ear_open_l = (
            self._ear_hist_l.percentile(90)
            if self._ear_hist_l.size >= CFG.earBaselineMinSamples
            else CFG.earOpenFallback
        )
        ear_open_r = (
            self._ear_hist_r.percentile(90)
            if self._ear_hist_r.size >= CFG.earBaselineMinSamples
            else CFG.earOpenFallback
        )
        ear_open = (ear_open_l + ear_open_r) / 2
        ear = (f.earL + f.earR) / 2

        c = _clamp01(
            (0.5 * _clamp01(1 - ear / ear_open)) / CFG.earDropFrac
            + 0.5 * ((f.blinkL + f.blinkR) / 2)
        )
        c_ear_l = _clamp01((1 - f.earL / ear_open_l) / CFG.earDropFrac)
        c_ear_r = _clamp01((1 - f.earR / ear_open_r) / CFG.earDropFrac)

        dt = 0.0 if self._prev_t is None else min(f.t - self._prev_t, CFG.dtCapMs)
        self._prev_t = f.t
        self.quality_ms += dt
        if c >= CFG.perclosLevel:
            self.perclos_ms += dt

        sample = _EvSample(t=f.t, c=c, asym=abs(c_ear_l - c_ear_r))

        if not self._open:
            # Rest level from the trailing window of *previous* non-event frames.
            self._rest = self._rest_level(f.t)
            if c - self._rest > p["promStart"]:
                # Include the preceding frame so the up-crossing can be interpolated —
                # but only if it's adjacent; after a gated gap it may be seconds old.
                prev = self._prev_sample
                pre = (
                    [_EvSample(t=prev.t, c=prev.c, asym=NAN)]
                    if prev is not None and f.t - prev.t <= CFG.dtCapMs
                    else []
                )
                self._open_event(f.t, pre + [sample])
            else:
                self._rest_hist.push(f.t, c)
                self._look_hist.push(f.t, f.lookDown)
                self._look_hist.evict_before(f.t - CFG.gazeRestWindowMs)
        else:
            self._event_samples.append(sample)
            idx = len(self._event_samples) - 1
            v = self._event_samples[self._valley_idx] if self._valley_idx >= 0 else None
            if c - self._open_rest < p["promEnd"]:
                self._close_event(idx)
            elif self._settled(idx):
                # The lids reopened onto a new, higher resting level (eyes stay
                # narrower after the blink): close here and re-seed the rest level
                # from the settled stretch instead of waiting for c to return to the
                # frozen pre-blink rest.
                settle = [s for s in self._event_samples if s.t >= f.t - p["settleMs"]]
                self._close_event(idx)
                self._rest_hist.clear()
                for s in settle:
                    self._rest_hist.push(s.t, s.c)
                self._rest = self._rest_hist.percentile(p["restPercentile"])
            elif v is not None and v.c <= self._open_peak - p["valleyDrop"] and c >= v.c + p["riseAgain"]:
                # Valley split: end here at the valley, reopen from the valley.
                vi = self._valley_idx
                tail = self._event_samples[vi:]
                rest = self._open_rest
                self._close_event(vi)
                self._open_event(tail[0].t, tail, rest)
            elif c > self._open_peak:
                self._open_peak = c
                self._valley_idx = -1
            elif self._valley_idx < 0 or c < self._event_samples[self._valley_idx].c:
                self._valley_idx = idx
            # Runaway guard: a sustained step in c (rest frozen) would otherwise
            # never close. Drop it and let the rest level absorb the new level.
            if self._open and f.t - self._open_start > CFG.maxBlinkMs:
                self._rest_hist.clear()
                for s in self._event_samples:
                    if s.t >= f.t - p["restWindowMs"] and math.isfinite(s.asym):
                        self._rest_hist.push(s.t, s.c)
                self._rest = self._rest_hist.percentile(p["restPercentile"])
                self._reset_open()
        self._prev_sample = sample
        if self.trace is not None:
            self.trace.append(
                {"t": f.t, "c": c, "rest": self._open_rest if self._open else self._rest}
            )

    def _rest_level(self, now: float) -> float:
        self._rest_hist.evict_before(now - self.params["restWindowMs"])
        if self._rest_hist.size == 0:
            return 0.0
        return self._rest_hist.percentile(self.params["restPercentile"])

    def _settled(self, idx: int) -> bool:
        """Has the open event settled after its peak? c is well below the peak
        (≤ peak − valleyDrop and ≤ the duration level) and has stayed within
        settleBand for the last settleMs."""
        p = self.params
        ss = self._event_samples
        now = ss[idx]
        level = duration_level_for(self._open_peak, self._open_rest)
        if now.c > self._open_peak - p["valleyDrop"] or now.c > level:
            return False
        lo = now.c
        hi = now.c
        for i in range(idx - 1, -1, -1):
            s = ss[i]
            if not math.isfinite(s.asym) or s.t < self._open_start:
                return False  # window not covered
            lo = min(lo, s.c)
            hi = max(hi, s.c)
            if hi - lo > p["settleBand"]:
                return False
            if s.t <= now.t - p["settleMs"]:
                return True
        return False

    def _open_event(self, start: float, samples: list, rest: float | None = None) -> None:
        if rest is None:
            rest = self._rest
        self._open = True
        self._open_start = start
        self._open_rest = rest
        self._event_samples = samples
        self._open_peak = 0.0
        self._valley_idx = -1
        # Peak/valley over the given samples (only frames from `start` on).
        for i, s in enumerate(samples):
            if s.t < start:
                continue
            if s.c > self._open_peak:
                self._open_peak = s.c
                self._valley_idx = -1
            elif self._valley_idx < 0 or s.c < samples[self._valley_idx].c:
                self._valley_idx = i

    def _reset_open(self) -> None:
        self._open = False
        self._open_peak = 0.0
        self._event_samples = []
        self._valley_idx = -1

    def _close_event(self, end_idx: int) -> None:
        """Close the open event at event_samples[end_idx] (inclusive)."""
        p = self.params
        samples = self._event_samples[: end_idx + 1]
        start = self._open_start
        end = samples[-1].t
        span_ms = end - start
        peak = self._open_peak
        rest = self._open_rest
        level = duration_level_for(peak, rest)
        # Invariant: 0 ≤ closedMs ≤ spanMs + 2·dtCapMs (pre-event interval + capped
        # gaps). Clamp defensively so a bad sample sequence can never leak out.
        raw = time_at_or_above(samples, level, CFG.dtCapMs)
        closed_ms = max(0.0, min(raw, span_ms + 2 * CFG.dtCapMs))
        # Close/reopen phases: split the time above the duration level at the
        # first peak sample. Slow reopening is a documented drowsiness correlate.
        peak_idx = -1
        for i, s in enumerate(samples):
            if s.c >= peak:
                peak_idx = i
                break
        close_ms = time_at_or_above(samples[: max(1, peak_idx + 1)], level, CFG.dtCapMs)
        reopen_ms = time_at_or_above(samples[max(0, peak_idx) :], level, CFG.dtCapMs)
        asyms = [s.asym for s in samples if math.isfinite(s.asym) and s.t >= start]
        asym = sum(asyms) / len(asyms) if asyms else 0.0
        self._reset_open()

        complete = peak >= CFG.peakComplete
        if span_ms > CFG.maxBlinkMs:
            return  # noise
        if not complete and peak - rest < p["promStart"]:
            return  # noise
        if asym > CFG.asymmetryMax:
            self.asymmetric_discards += 1
            return
        ev = BlinkEvent(
            start=start,
            end=end,
            durationMs=closed_ms,
            closedMs=closed_ms,
            spanMs=span_ms,
            peak=peak,
            rest=rest,
            complete=complete,
            longClosure=complete and closed_ms > CFG.longClosureMs,
            closeMs=close_ms,
            reopenMs=reopen_ms,
        )
        # Gaze-down check is deferred: the decision needs lookDown from AFTER the
        # event (lid drop at onset reads as gaze-down, so a pre-event window is
        # confounded). Resolved by drain_pending/flush_pending.
        self._look_hist.evict_before(end - CFG.gazeRestWindowMs)
        rest_look = self._look_hist.percentile(50) if self._look_hist.size > 0 else NAN
        self._pending.append(
            {
                "ev": ev,
                "postLo": end + CFG.gazePostOffsetMs,
                "postEnd": end + CFG.gazePostOffsetMs + CFG.gazePostMs,
                "restLook": rest_look,
            }
        )

    def _drain_pending(self, now: float) -> None:
        """Finalise pending events whose post-event lookDown window is covered."""
        while self._pending and self._pending[0]["postEnd"] <= now:
            p = self._pending.pop(0)
            # The next blink's lid drop reads as lookDown too, so if another event
            # opens inside (or just after) the window the gaze check is unobservable.
            # Pad: an event's detect-start lags its signal onset.
            if self._open:
                next_start = self._open_start
            elif self._pending:
                next_start = self._pending[0]["ev"].start
            else:
                next_start = None
            if next_start is not None and next_start <= p["postEnd"] + CFG.gazeNeighborPadMs:
                self.events.append(p["ev"])
                continue
            win = [s["lookDown"] for s in self._recent if p["postLo"] <= s["t"] <= p["postEnd"]]
            if len(win) == 0 or not math.isfinite(p["restLook"]):
                self.events.append(p["ev"])  # window not observable → accept unchecked
                continue
            win.sort()
            n = len(win)
            med = win[(n - 1) // 2] if n % 2 else (win[n // 2 - 1] + win[n // 2]) / 2
            if med - p["restLook"] > self.params["gazeDownRise"]:
                self.gaze_down_discards += 1
            else:
                self.events.append(p["ev"])

    def _flush_pending(self) -> None:
        """Accept every pending event without the gaze check (gap / end of stream)."""
        for p in self._pending:
            self.events.append(p["ev"])
        self._pending.clear()

    def finish(self) -> None:
        """End of stream: close any open event at its last sample and release all
        pending events (their post windows can't be covered) unchecked."""
        if self._open:
            self._close_event(len(self._event_samples) - 1)
        self._flush_pending()

    @property
    def candidate_count(self) -> int:
        """Candidate events = accepted + the two tracked discard kinds."""
        return len(self.events) + self.gaze_down_discards + self.asymmetric_discards

    @property
    def discard_pct(self) -> float:
        n = self.candidate_count
        return ((self.gaze_down_discards + self.asymmetric_discards) / n) * 100 if n > 0 else 0.0

    @property
    def perclos(self) -> float:
        return self.perclos_ms / self.quality_ms if self.quality_ms > 0 else 0.0

    @property
    def inter_blink_intervals(self) -> list:
        """Gaps without a blink start: between consecutive event starts, plus the
        leading gap (first quality frame → first event) and trailing gap
        (last event start → last quality frame). With zero events the whole
        quality span is one gap."""
        if self._first_quality_t is None or self._last_quality_t is None:
            return []
        if len(self.events) == 0:
            return [self._last_quality_t - self._first_quality_t]
        starts = [e.start for e in self.events]
        gaps = [starts[0] - self._first_quality_t]
        for i in range(1, len(starts)):
            gaps.append(starts[i] - starts[i - 1])
        gaps.append(self._last_quality_t - starts[-1])
        return gaps


class _RollingWindow:
    """Time-windowed sample buffer with an always-sorted copy of the values, so a
    percentile is O(1) and push/evict are a binary search + remove."""

    def __init__(self) -> None:
        self._q: list = []  # [(t, v)]
        self._head = 0
        self._sorted: list = []

    @property
    def size(self) -> int:
        return len(self._sorted)

    def push(self, t: float, v: float) -> None:
        self._q.append((t, v))
        self._sorted.insert(bisect_left(self._sorted, v), v)

    def evict_before(self, cut: float) -> None:
        while self._head < len(self._q) and self._q[self._head][0] < cut:
            v = self._q[self._head][1]
            self._head += 1
            self._sorted.pop(bisect_left(self._sorted, v))
        if self._head > 1024 and self._head * 2 > len(self._q):
            self._q = self._q[self._head :]
            self._head = 0

    def clear(self) -> None:
        self._q = []
        self._head = 0
        self._sorted = []

    def percentile(self, pct: float) -> float:
        """Value at sorted index floor(pct/100 · n) (clamped); earOpenFallback if empty."""
        n = len(self._sorted)
        if n == 0:
            return CFG.earOpenFallback
        return self._sorted[min(n - 1, math.floor((pct / 100) * n))]
