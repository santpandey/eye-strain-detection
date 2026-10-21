//! Blink detector v2 — 1:1 port of src/lib/analysis/blink.ts.
//!
//! Events are found by *prominence* over a local rest level (a low rolling
//! percentile of c, frozen while an event is open), so a drifting resting c
//! doesn't break start/end. Rapid successive blinks whose valleys never
//! return to rest are split at the valley when c drops ≥ valleyDrop below
//! the peak and rises ≥ riseAgain again. The gaze-down discard is deferred:
//! it needs lookDown from AFTER the event.

use crate::config;
use crate::features::FrameFeatures;
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlinkEvent {
    pub start: f64,
    pub end: f64,
    /// Blink duration (= closedMs). Used for meanBlinkMs / longClosure.
    pub duration_ms: f64,
    /// Time c ≥ rest + durationFrac·(peak − rest), interpolated; gaps capped
    /// at dtCapMs. 0 ≤ closedMs ≤ spanMs + 2·dtCapMs.
    pub closed_ms: f64,
    /// Detection start→end span (inflated by slow tails). Debug.
    pub span_ms: f64,
    pub peak: f64,
    /// Local rest level of c the event was measured against.
    pub rest: f64,
    pub complete: bool,     // peak >= peakComplete (absolute)
    pub long_closure: bool, // complete && closedMs > longClosureMs
    /// Time above the duration level before the peak (closing phase).
    pub close_ms: f64,
    /// Time above the duration level after the peak (reopening phase).
    pub reopen_ms: f64,
}

/// Knobs of the v2 (prominence + valley split) detector. Defaults from config.
#[derive(Debug, Clone, Copy)]
pub struct BlinkParams {
    pub prom_start: f64,
    pub prom_end: f64,
    pub valley_drop: f64,
    pub rise_again: f64,
    pub rest_window_ms: f64,
    pub rest_percentile: f64,
    pub settle_ms: f64,
    pub settle_band: f64,
    pub gaze_down_rise: f64,
}

impl Default for BlinkParams {
    fn default() -> Self {
        BlinkParams {
            prom_start: config::PROM_START,
            prom_end: config::PROM_END,
            valley_drop: config::VALLEY_DROP,
            rise_again: config::RISE_AGAIN,
            rest_window_ms: config::REST_WINDOW_MS,
            rest_percentile: config::REST_PERCENTILE,
            settle_ms: config::SETTLE_MS,
            settle_band: config::SETTLE_BAND,
            gaze_down_rise: config::GAZE_DOWN_RISE,
        }
    }
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Level at which blink duration is measured: halfway (durationFrac) from
/// rest to peak.
pub fn duration_level_for(peak: f64, rest: f64) -> f64 {
    rest + config::DURATION_FRAC * (peak - rest)
}

#[derive(Debug, Clone, Copy)]
pub struct CcSample {
    pub t: f64,
    pub c: f64,
}

/// Total time a piecewise-linear signal (samples in time order) spends at or
/// above `level`, with crossings linearly interpolated between frames.
///
/// Intervals longer than `cap_ms` are gaps (quality-gated frames never reach
/// the detector): they contribute exactly `cap_ms` when both endpoints are
/// ≥ level and nothing otherwise — we don't interpolate a crossing across a
/// gap.
pub fn time_at_or_above(samples: &[CcSample], level: f64, cap_ms: f64) -> f64 {
    let mut total = 0.0;
    for i in 1..samples.len() {
        let a = samples[i - 1];
        let b = samples[i];
        let dt = b.t - a.t;
        if dt <= 0.0 {
            continue;
        }
        let a_in = a.c >= level;
        let b_in = b.c >= level;
        if a_in && b_in {
            total += dt.min(cap_ms);
        } else if a_in != b_in && dt <= cap_ms {
            let frac = (level - a.c) / (b.c - a.c); // crossing point in [0, 1]
            total += if a_in { frac * dt } else { (1.0 - frac) * dt };
        }
    }
    total
}

#[derive(Debug, Clone, Copy)]
struct RecentSample {
    t: f64,
    look_down: f64,
}

/// Closed event awaiting its post-event lookDown window before the gaze check.
#[derive(Debug, Clone)]
struct PendingEvent {
    ev: BlinkEvent,
    post_lo: f64,
    post_end: f64,
    /// Median rest lookDown at close time; NaN when no rest samples existed.
    rest_look: f64,
}

#[derive(Debug, Clone, Copy)]
struct EvSample {
    t: f64,
    c: f64,
    /// |cEarL − cEarR|, or NaN for the borrowed pre-event frame.
    asym: f64,
}

/// Optional per-frame debug record (eval tooling).
#[derive(Debug, Clone, Copy)]
pub struct BlinkTraceSample {
    pub t: f64,
    pub c: f64,
    pub rest: f64,
}

/// Blink detector v2 over quality frames only. Callers pre-filter with
/// QualityCtx — dropped frames never reach push().
#[derive(Debug)]
pub struct BlinkDetector {
    pub events: Vec<BlinkEvent>,
    pub perclos_ms: f64,
    pub quality_ms: f64,
    pub gaze_down_discards: usize,
    pub asymmetric_discards: usize,
    /// Set to Some(vec) to record (t, c, rest) for every pushed frame.
    pub trace: Option<Vec<BlinkTraceSample>>,

    pub params: BlinkParams,

    ear_hist_l: RollingWindow,
    ear_hist_r: RollingWindow,
    rest_hist: RollingWindow,
    look_hist: RollingWindow, // rest lookDown over non-event frames
    rest: f64,
    recent: VecDeque<RecentSample>, // lookDown for pending post-event windows
    pending: VecDeque<PendingEvent>,
    prev_t: Option<f64>,
    first_quality_t: Option<f64>,
    last_quality_t: Option<f64>,
    prev_sample: Option<EvSample>,

    // Open event state.
    open: bool,
    open_start: f64,
    open_peak: f64,
    open_rest: f64,
    event_samples: Vec<EvSample>,
    /// Index into event_samples of the lowest sample since the peak, or -1.
    valley_idx: i64,
}

impl Default for BlinkDetector {
    fn default() -> Self {
        BlinkDetector {
            events: Vec::new(),
            perclos_ms: 0.0,
            quality_ms: 0.0,
            gaze_down_discards: 0,
            asymmetric_discards: 0,
            trace: None,
            params: BlinkParams::default(),
            ear_hist_l: RollingWindow::default(),
            ear_hist_r: RollingWindow::default(),
            rest_hist: RollingWindow::default(),
            look_hist: RollingWindow::default(),
            rest: 0.0,
            recent: VecDeque::new(),
            pending: VecDeque::new(),
            prev_t: None,
            first_quality_t: None,
            last_quality_t: None,
            prev_sample: None,
            open: false,
            open_start: 0.0,
            open_peak: 0.0,
            open_rest: 0.0,
            event_samples: Vec::new(),
            valley_idx: -1,
        }
    }
}

impl BlinkDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_params(params: BlinkParams) -> Self {
        BlinkDetector {
            params,
            ..Self::default()
        }
    }

    pub fn push(&mut self, f: &FrameFeatures) {
        let p = self.params;
        if self.first_quality_t.is_none() {
            self.first_quality_t = Some(f.t);
        }
        self.last_quality_t = Some(f.t);

        // Resolve deferred gaze checks first: a gap in the stream means the
        // post-event window can never be judged — accept pending events
        // unchecked.
        let gap = self.prev_t.is_some_and(|pt| f.t - pt > config::DT_CAP_MS);
        self.recent.push_back(RecentSample {
            t: f.t,
            look_down: f.look_down,
        });
        let keep_since =
            f.t - (config::MAX_BLINK_MS + config::GAZE_POST_OFFSET_MS + config::GAZE_POST_MS);
        while self.recent.front().is_some_and(|s| s.t < keep_since) {
            self.recent.pop_front();
        }
        if gap {
            self.flush_pending();
        } else {
            self.drain_pending(f.t);
        }

        // Per-eye open baselines over the trailing window.
        self.ear_hist_l.push(f.t, f.ear_l);
        self.ear_hist_r.push(f.t, f.ear_r);
        let cutoff = f.t - config::EAR_BASELINE_MS;
        self.ear_hist_l.evict_before(cutoff);
        self.ear_hist_r.evict_before(cutoff);
        let ear_open_l = if self.ear_hist_l.size() >= config::EAR_BASELINE_MIN_SAMPLES {
            self.ear_hist_l.percentile(90.0)
        } else {
            config::EAR_OPEN_FALLBACK
        };
        let ear_open_r = if self.ear_hist_r.size() >= config::EAR_BASELINE_MIN_SAMPLES {
            self.ear_hist_r.percentile(90.0)
        } else {
            config::EAR_OPEN_FALLBACK
        };
        let ear_open = (ear_open_l + ear_open_r) / 2.0;
        let ear = (f.ear_l + f.ear_r) / 2.0;

        let c = clamp01(
            (0.5 * clamp01(1.0 - ear / ear_open)) / config::EAR_DROP_FRAC
                + 0.5 * ((f.blink_l + f.blink_r) / 2.0),
        );
        let c_ear_l = clamp01((1.0 - f.ear_l / ear_open_l) / config::EAR_DROP_FRAC);
        let c_ear_r = clamp01((1.0 - f.ear_r / ear_open_r) / config::EAR_DROP_FRAC);

        let dt = match self.prev_t {
            None => 0.0,
            Some(pt) => (f.t - pt).min(config::DT_CAP_MS),
        };
        self.prev_t = Some(f.t);
        self.quality_ms += dt;
        if c >= config::PERCLOS_LEVEL {
            self.perclos_ms += dt;
        }

        let sample = EvSample {
            t: f.t,
            c,
            asym: (c_ear_l - c_ear_r).abs(),
        };

        if !self.open {
            // Rest level from the trailing window of *previous* non-event
            // frames.
            self.rest = self.rest_level(f.t);
            if c - self.rest > p.prom_start {
                // Include the preceding frame so the up-crossing can be
                // interpolated — but only if it's adjacent; after a gated gap
                // it may be seconds old.
                let mut pre: Vec<EvSample> = Vec::new();
                if let Some(prev) = self.prev_sample {
                    if f.t - prev.t <= config::DT_CAP_MS {
                        pre.push(EvSample {
                            asym: f64::NAN,
                            ..prev
                        });
                    }
                }
                pre.push(sample);
                self.open_event(f.t, pre, None);
            } else {
                self.rest_hist.push(f.t, c);
                self.look_hist.push(f.t, f.look_down);
                self.look_hist
                    .evict_before(f.t - config::GAZE_REST_WINDOW_MS);
            }
        } else {
            self.event_samples.push(sample);
            let idx = self.event_samples.len() - 1;
            let v = if self.valley_idx >= 0 {
                Some(self.event_samples[self.valley_idx as usize])
            } else {
                None
            };
            if c - self.open_rest < p.prom_end {
                self.close_event(idx);
            } else if self.settled(idx) {
                // The lids reopened onto a new, higher resting level (eyes
                // stay narrower after the blink): close here and re-seed the
                // rest level from the settled stretch instead of waiting for
                // c to return to the frozen pre-blink rest.
                let settle: Vec<EvSample> = self
                    .event_samples
                    .iter()
                    .copied()
                    .filter(|s| s.t >= f.t - p.settle_ms)
                    .collect();
                self.close_event(idx);
                self.rest_hist.clear();
                for s in settle {
                    self.rest_hist.push(s.t, s.c);
                }
                self.rest = self.rest_hist.percentile(p.rest_percentile);
            } else if v
                .is_some_and(|v| v.c <= self.open_peak - p.valley_drop && c >= v.c + p.rise_again)
            {
                // Valley split: end here at the valley, reopen from the valley.
                let vi = self.valley_idx as usize;
                let tail: Vec<EvSample> = self.event_samples[vi..].to_vec();
                let rest = self.open_rest;
                self.close_event(vi);
                self.open_event(tail[0].t, tail, Some(rest));
            } else if c > self.open_peak {
                self.open_peak = c;
                self.valley_idx = -1;
            } else if self.valley_idx < 0 || c < self.event_samples[self.valley_idx as usize].c {
                self.valley_idx = idx as i64;
            }
            // Runaway guard: a sustained step in c (rest frozen) would
            // otherwise never close. Drop it and let the rest level absorb the
            // new level.
            if self.open && f.t - self.open_start > config::MAX_BLINK_MS {
                self.rest_hist.clear();
                for s in &self.event_samples {
                    if s.t >= f.t - p.rest_window_ms && s.asym.is_finite() {
                        self.rest_hist.push(s.t, s.c);
                    }
                }
                self.rest = self.rest_hist.percentile(p.rest_percentile);
                self.reset_open();
            }
        }
        self.prev_sample = Some(sample);
        if let Some(trace) = self.trace.as_mut() {
            trace.push(BlinkTraceSample {
                t: f.t,
                c,
                rest: if self.open { self.open_rest } else { self.rest },
            });
        }
    }

    fn rest_level(&mut self, now: f64) -> f64 {
        self.rest_hist
            .evict_before(now - self.params.rest_window_ms);
        if self.rest_hist.size() == 0 {
            return 0.0;
        }
        self.rest_hist.percentile(self.params.rest_percentile)
    }

    /// Has the open event settled after its peak? c is well below the peak
    /// (≤ peak − valleyDrop and ≤ the duration level) and has stayed within
    /// settleBand for the last settleMs.
    fn settled(&self, idx: usize) -> bool {
        let p = self.params;
        let ss = &self.event_samples;
        let now = ss[idx];
        let level = duration_level_for(self.open_peak, self.open_rest);
        if now.c > self.open_peak - p.valley_drop || now.c > level {
            return false;
        }
        let mut lo = now.c;
        let mut hi = now.c;
        for i in (0..idx).rev() {
            let s = ss[i];
            if !s.asym.is_finite() || s.t < self.open_start {
                return false; // window not covered
            }
            lo = lo.min(s.c);
            hi = hi.max(s.c);
            if hi - lo > p.settle_band {
                return false;
            }
            if s.t <= now.t - p.settle_ms {
                return true;
            }
        }
        false
    }

    fn open_event(&mut self, start: f64, samples: Vec<EvSample>, rest: Option<f64>) {
        self.open = true;
        self.open_start = start;
        self.open_rest = rest.unwrap_or(self.rest);
        self.event_samples = samples;
        self.open_peak = 0.0;
        self.valley_idx = -1;
        // Peak/valley over the given samples (only frames from `start` on).
        for i in 0..self.event_samples.len() {
            let s = self.event_samples[i];
            if s.t < start {
                continue;
            }
            if s.c > self.open_peak {
                self.open_peak = s.c;
                self.valley_idx = -1;
            } else if self.valley_idx < 0 || s.c < self.event_samples[self.valley_idx as usize].c {
                self.valley_idx = i as i64;
            }
        }
    }

    fn reset_open(&mut self) {
        self.open = false;
        self.open_peak = 0.0;
        self.event_samples = Vec::new();
        self.valley_idx = -1;
    }

    /// Close the open event at event_samples[end_idx] (inclusive).
    fn close_event(&mut self, end_idx: usize) {
        let p = self.params;
        let samples: Vec<EvSample> = self.event_samples[..end_idx + 1].to_vec();
        let start = self.open_start;
        let end = samples[samples.len() - 1].t;
        let span_ms = end - start;
        let peak = self.open_peak;
        let rest = self.open_rest;
        let level = duration_level_for(peak, rest);
        let cc: Vec<CcSample> = samples
            .iter()
            .map(|s| CcSample { t: s.t, c: s.c })
            .collect();
        // Invariant: 0 ≤ closedMs ≤ spanMs + 2·dtCapMs (pre-event interval +
        // capped gaps). Clamp defensively so a bad sample sequence can never
        // leak out.
        let raw = time_at_or_above(&cc, level, config::DT_CAP_MS);
        let closed_ms = raw.max(0.0).min(span_ms + 2.0 * config::DT_CAP_MS);
        // Close/reopen phases: split the time above the duration level at the
        // first peak sample. Slow reopening is a documented drowsiness
        // correlate.
        let peak_idx = samples
            .iter()
            .position(|s| s.c >= peak)
            .map(|i| i as i64)
            .unwrap_or(-1);
        let close_end = ((peak_idx + 1).max(1)) as usize;
        let close_ms = time_at_or_above(&cc[..close_end.min(cc.len())], level, config::DT_CAP_MS);
        let reopen_start = peak_idx.max(0) as usize;
        let reopen_ms = time_at_or_above(&cc[reopen_start..], level, config::DT_CAP_MS);
        let asyms: Vec<f64> = samples
            .iter()
            .filter(|s| s.asym.is_finite() && s.t >= start)
            .map(|s| s.asym)
            .collect();
        let asym = if asyms.is_empty() {
            0.0
        } else {
            asyms.iter().sum::<f64>() / asyms.len() as f64
        };
        self.reset_open();

        let complete = peak >= config::PEAK_COMPLETE;
        if span_ms > config::MAX_BLINK_MS {
            return; // noise
        }
        if !complete && peak - rest < p.prom_start {
            return; // noise
        }
        if asym > config::ASYMMETRY_MAX {
            self.asymmetric_discards += 1;
            return;
        }
        let ev = BlinkEvent {
            start,
            end,
            duration_ms: closed_ms,
            closed_ms,
            span_ms,
            peak,
            rest,
            complete,
            long_closure: complete && closed_ms > config::LONG_CLOSURE_MS,
            close_ms,
            reopen_ms,
        };
        // Gaze-down check is deferred: the decision needs lookDown from AFTER
        // the event (lid drop at onset reads as gaze-down, so a pre-event
        // window is confounded). Resolved by drain_pending/flush_pending.
        self.look_hist
            .evict_before(end - config::GAZE_REST_WINDOW_MS);
        let rest_look = if self.look_hist.size() > 0 {
            self.look_hist.percentile(50.0)
        } else {
            f64::NAN
        };
        self.pending.push_back(PendingEvent {
            ev,
            post_lo: end + config::GAZE_POST_OFFSET_MS,
            post_end: end + config::GAZE_POST_OFFSET_MS + config::GAZE_POST_MS,
            rest_look,
        });
    }

    /// Finalise pending events whose post-event lookDown window is covered.
    fn drain_pending(&mut self, now: f64) {
        while self.pending.front().is_some_and(|p| p.post_end <= now) {
            let p = self.pending.pop_front().expect("front checked");
            // The next blink's lid drop reads as lookDown too, so if another
            // event opens inside (or just after) the window the gaze check is
            // unobservable. Pad: an event's detect-start lags its signal onset.
            let next_start = if self.open {
                Some(self.open_start)
            } else {
                self.pending.front().map(|p| p.ev.start)
            };
            if next_start.is_some_and(|ns| ns <= p.post_end + config::GAZE_NEIGHBOR_PAD_MS) {
                self.events.push(p.ev);
                continue;
            }
            let mut win: Vec<f64> = self
                .recent
                .iter()
                .filter(|s| s.t >= p.post_lo && s.t <= p.post_end)
                .map(|s| s.look_down)
                .collect();
            if win.is_empty() || !p.rest_look.is_finite() {
                self.events.push(p.ev); // window not observable → accept unchecked
                continue;
            }
            win.sort_by(f64::total_cmp);
            let med = if win.len() % 2 == 1 {
                win[(win.len() - 1) / 2]
            } else {
                (win[win.len() / 2 - 1] + win[win.len() / 2]) / 2.0
            };
            if med - p.rest_look > self.params.gaze_down_rise {
                self.gaze_down_discards += 1;
            } else {
                self.events.push(p.ev);
            }
        }
    }

    /// Accept every pending event without the gaze check (gap / end of stream).
    fn flush_pending(&mut self) {
        while let Some(p) = self.pending.pop_front() {
            self.events.push(p.ev);
        }
    }

    /// End of stream: close any open event at its last sample and release all
    /// pending events (their post windows can't be covered) unchecked.
    pub fn finish(&mut self) {
        if self.open {
            self.close_event(self.event_samples.len() - 1);
        }
        self.flush_pending();
    }

    /// Candidate events = accepted + the two tracked discard kinds.
    pub fn candidate_count(&self) -> usize {
        self.events.len() + self.gaze_down_discards + self.asymmetric_discards
    }

    pub fn discard_pct(&self) -> f64 {
        let n = self.candidate_count();
        if n > 0 {
            ((self.gaze_down_discards + self.asymmetric_discards) as f64 / n as f64) * 100.0
        } else {
            0.0
        }
    }

    pub fn perclos(&self) -> f64 {
        if self.quality_ms > 0.0 {
            self.perclos_ms / self.quality_ms
        } else {
            0.0
        }
    }

    /// Gaps without a blink start: between consecutive event starts, plus the
    /// leading gap (first quality frame → first event) and trailing gap (last
    /// event start → last quality frame). With zero events the whole quality
    /// span is one gap.
    pub fn inter_blink_intervals(&self) -> Vec<f64> {
        let (Some(first), Some(last)) = (self.first_quality_t, self.last_quality_t) else {
            return Vec::new();
        };
        if self.events.is_empty() {
            return vec![last - first];
        }
        let starts: Vec<f64> = self.events.iter().map(|e| e.start).collect();
        let mut gaps = vec![starts[0] - first];
        for i in 1..starts.len() {
            gaps.push(starts[i] - starts[i - 1]);
        }
        gaps.push(last - starts[starts.len() - 1]);
        gaps
    }
}

/// Time-windowed sample buffer with an always-sorted copy of the values, so a
/// percentile is O(1) and push/evict are a binary search + splice.
#[derive(Debug, Default)]
struct RollingWindow {
    q: VecDeque<(f64, f64)>, // (t, v)
    sorted: Vec<f64>,
}

impl RollingWindow {
    fn size(&self) -> usize {
        self.sorted.len()
    }

    fn push(&mut self, t: f64, v: f64) {
        self.q.push_back((t, v));
        let idx = lower_bound(&self.sorted, v);
        self.sorted.insert(idx, v);
    }

    fn evict_before(&mut self, cut: f64) {
        while self.q.front().is_some_and(|&(t, _)| t < cut) {
            let (_, v) = self.q.pop_front().expect("front checked");
            let idx = lower_bound(&self.sorted, v);
            // The element is guaranteed present; TS splice removes the first
            // instance at/after idx — lowerBound already lands on it.
            if idx < self.sorted.len() {
                self.sorted.remove(idx);
            }
        }
    }

    fn clear(&mut self) {
        self.q.clear();
        self.sorted.clear();
    }

    /// Value at sorted index floor(pct/100 · n) (clamped); earOpenFallback if
    /// empty.
    fn percentile(&self, pct: f64) -> f64 {
        let n = self.sorted.len();
        if n == 0 {
            return config::EAR_OPEN_FALLBACK;
        }
        self.sorted[((pct / 100.0) * n as f64).floor().min((n - 1) as f64) as usize]
    }
}

fn lower_bound(arr: &[f64], v: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = arr.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if arr[mid] < v {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}
