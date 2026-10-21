//! Port of tests/blink.test.ts — the detector cases that guard the ported
//! state machine. Frame builders mirror tests/helpers.ts (30 fps clock,
//! ear 0.3 / blink 0 open eyes).

use blinkwell::blink::{time_at_or_above, BlinkDetector, CcSample};
use blinkwell::config;
use blinkwell::features::FrameFeatures;
use blinkwell::quality::QualityCtx;

const FPS: f64 = 30.0;
const DT: f64 = 1000.0 / FPS;

thread_local! {
    static T: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

fn reset_clock() {
    T.with(|t| t.set(0.0));
}

/// A quality, eyes-open frame. Overrides simulate blinks etc.
fn frame(over: impl FnOnce(&mut FrameFeatures)) -> FrameFeatures {
    let t = T.with(|t| {
        let v = t.get() + DT;
        t.set(v);
        v
    });
    let mut f = FrameFeatures {
        t,
        face: true,
        ear_l: 0.3,
        ear_r: 0.3,
        blink_l: 0.0,
        blink_r: 0.0,
        squint_l: 0.0,
        squint_r: 0.0,
        jaw_open: 0.0,
        look_down: 0.0,
        yaw: 0.0,
        pitch: 0.0,
        roll: 0.0,
        iris_px: 12.0,
        interocular_px: 150.0,
        eye_centers: [[0.4, 0.4], [0.6, 0.4]],
        eye_contour: Vec::new(),
        nose: [0.5, 0.5],
        frame_luma: 120.0,
        face_luma: 120.0,
        glare: [0.0, 0.0],
        frame_w: 640.0,
        frame_h: 480.0,
    };
    over(&mut f);
    f
}

fn plain_frame() -> FrameFeatures {
    frame(|_| {})
}

/// n open frames.
fn open(n: usize) -> Vec<FrameFeatures> {
    (0..n).map(|_| plain_frame()).collect()
}

fn open_with(n: usize, over: impl Fn(&mut FrameFeatures)) -> Vec<FrameFeatures> {
    (0..n).map(|_| frame(&over)).collect()
}

/// n fully-closed frames (c ≈ 1).
fn closed(n: usize) -> Vec<FrameFeatures> {
    open_with(n, |f| {
        f.ear_l = 0.0;
        f.ear_r = 0.0;
        f.blink_l = 1.0;
        f.blink_r = 1.0;
    })
}

fn closed_with(n: usize, over: impl Fn(&mut FrameFeatures)) -> Vec<FrameFeatures> {
    open_with(n, |f| {
        f.ear_l = 0.0;
        f.ear_r = 0.0;
        f.blink_l = 1.0;
        f.blink_r = 1.0;
        over(f);
    })
}

/// n partially-closed frames (peak c ≈ 0.6 → incomplete).
fn half_closed(n: usize) -> Vec<FrameFeatures> {
    open_with(n, |f| {
        f.ear_l = 0.15;
        f.ear_r = 0.15;
        f.blink_l = 0.4;
        f.blink_r = 0.4;
    })
}

/// n noisy sub-threshold frames (c ≈ 0.15).
fn noise(n: usize) -> Vec<FrameFeatures> {
    open_with(n, |f| {
        f.ear_l = 0.27;
        f.ear_r = 0.27;
        f.blink_l = 0.13;
        f.blink_r = 0.13;
    })
}

fn feed_all(det: &mut BlinkDetector, seq: &[FrameFeatures]) {
    for f in seq {
        det.push(f);
    }
}

/// Set symmetric ear/blink so closure c equals `c` (earOpen 0.3).
fn with_closure(f: &mut FrameFeatures, c: f64) {
    let ear = 0.3 * (1.0 - 0.6 * c);
    f.ear_l = ear;
    f.ear_r = ear;
    f.blink_l = c;
    f.blink_r = c;
}

fn closed_frames(cs: &[f64]) -> Vec<FrameFeatures> {
    cs.iter()
        .map(|&c| {
            let mut f = plain_frame();
            with_closure(&mut f, c);
            f
        })
        .collect()
}

#[test]
fn counts_10_normal_150ms_blinks_all_complete() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = Vec::new();
    for _ in 0..10 {
        seq.extend(open(174)); // ~5.8 s of open eyes between blinks
        seq.extend(closed(5)); // ~167 ms closure
    }
    seq.extend(open(10));
    feed_all(&mut det, &seq);
    det.finish(); // last event's post-window isn't covered → release unchecked
    assert_eq!(det.events.len(), 10);
    assert!(det.events.iter().all(|e| e.complete));
    assert!(det
        .events
        .iter()
        .all(|e| e.duration_ms > 100.0 && e.duration_ms < 250.0));
    let rate = det.events.len() as f64 / (det.quality_ms / 60000.0);
    assert!(rate > 9.0 && rate < 11.0, "rate {rate}");
}

#[test]
fn counts_half_closures_as_incomplete() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(60);
    seq.extend(half_closed(5));
    seq.extend(open(60));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.peak >= 0.45, "peak {}", e.peak);
    assert!(e.peak < 0.8);
    assert!(!e.complete);
}

#[test]
fn splits_closed_time_into_close_reopen_phases() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(60);
    for c in [1.0, 1.0, 0.8, 0.6, 0.4, 0.2] {
        let mut f = plain_frame();
        with_closure(&mut f, c);
        seq.push(f);
    }
    seq.extend(open(60));
    feed_all(&mut det, &seq);
    det.finish();
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.reopen_ms > e.close_ms);
    assert!(e.close_ms + e.reopen_ms > 0.0);
    assert!(e.close_ms + e.reopen_ms <= e.span_ms + 2.0 * config::DT_CAP_MS);
}

#[test]
fn flags_800ms_complete_closure_as_long_closure() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(60);
    seq.extend(closed(24));
    seq.extend(open(60));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    assert!(det.events[0].complete);
    assert!(det.events[0].long_closure);
}

#[test]
fn measures_perclos_for_2s_eyes_closed_span() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(30 * 30);
    seq.extend(closed(2 * 30));
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    // Quality time ≈ 32 s; closed fraction ≈ 2/32.
    assert!(det.perclos() > 0.05, "perclos {}", det.perclos());
    assert!(det.perclos() < 0.08);
}

#[test]
fn non_quality_frames_gated_out_upstream() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut ctx = QualityCtx::new();
    let feed = |det: &mut BlinkDetector, ctx: &mut QualityCtx, seq: &[FrameFeatures]| {
        for f in seq {
            if ctx.check(f).ok {
                det.push(f);
            }
        }
    };
    feed(&mut det, &mut ctx, &open(30));
    let before = det.quality_ms;
    feed(&mut det, &mut ctx, &open_with(30, |f| f.yaw = 30.0));
    assert_eq!(det.quality_ms, before);
    // A "blink" hidden inside bad frames is not seen.
    let mut seq = closed_with(5, |f| f.yaw = 30.0);
    seq.extend(open(30));
    feed(&mut det, &mut ctx, &seq);
    assert_eq!(det.events.len(), 0);
}

#[test]
fn keeps_blinks_when_lookdown_rises_at_onset() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(60));
    // lookDown spikes around the blink (lid drop reads as gaze-down).
    feed_all(&mut det, &open_with(3, |f| f.look_down = 0.7));
    feed_all(&mut det, &closed_with(5, |f| f.look_down = 0.7));
    feed_all(&mut det, &open(60));
    assert_eq!(det.events.len(), 1);
    assert_eq!(det.gaze_down_discards, 0);
}

#[test]
fn discards_closures_followed_by_sustained_gaze_down() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(60));
    feed_all(&mut det, &closed(5));
    // user keeps looking down after the lids reopen: rest 0 → post ≈ 0.35
    feed_all(&mut det, &open_with(60, |f| f.look_down = 0.35));
    assert_eq!(det.events.len(), 0);
    assert_eq!(det.gaze_down_discards, 1);
}

#[test]
fn keeps_blinks_for_high_resting_lookdown_user() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open_with(60, |f| f.look_down = 0.6));
    feed_all(&mut det, &closed_with(5, |f| f.look_down = 0.6));
    feed_all(&mut det, &open_with(60, |f| f.look_down = 0.6));
    assert_eq!(det.events.len(), 1);
    assert_eq!(det.gaze_down_discards, 0);
}

#[test]
fn flushes_pending_event_at_finish() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(60));
    feed_all(&mut det, &closed(5));
    det.finish(); // no post-window frames: accepted unchecked
    assert_eq!(det.events.len(), 1);
    assert_eq!(det.gaze_down_discards, 0);
}

#[test]
fn discards_asymmetric_closures_one_eye_open() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(60));
    // left eye closes, right stays open; blendshape pushes c past start
    feed_all(
        &mut det,
        &open_with(5, |f| {
            f.ear_l = 0.0;
            f.blink_l = 0.7;
            f.blink_r = 0.7;
        }),
    );
    feed_all(&mut det, &open(60));
    assert_eq!(det.events.len(), 0);
    assert_eq!(det.asymmetric_discards, 1);
}

#[test]
fn discards_sub_promstart_noise_wiggles() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(60);
    seq.extend(noise(4));
    seq.extend(open(60));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 0);
}

#[test]
fn counts_inter_blink_gaps_over_10s() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(30);
    seq.extend(closed(5)); // blink 1
    seq.extend(open(30 * 12)); // 12 s gap
    seq.extend(closed(5)); // blink 2
    seq.extend(open(30 * 5));
    seq.extend(closed(5)); // blink 3, gap 5 s
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 3);
    let gaps = det.inter_blink_intervals();
    // leading ~1 s, 12 s, 5 s, trailing ~1 s
    assert_eq!(gaps.len(), 4);
    assert!(gaps[1] > 10_000.0);
    assert_eq!(gaps.iter().filter(|&&g| g > 10_000.0).count(), 1);
}

#[test]
fn whole_quality_span_is_gap_with_no_blinks() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(15 * 30));
    let gaps = det.inter_blink_intervals();
    assert_eq!(gaps.len(), 1);
    assert!(gaps[0] > 14_000.0);
    assert!(gaps[0] <= 15_000.0);
    assert_eq!(gaps.iter().filter(|&&g| g > 10_000.0).count(), 1);
}

#[test]
fn counts_leading_gap_before_first_blink() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let mut seq = open(30 * 12);
    seq.extend(closed(5));
    seq.extend(open(30 * 5));
    feed_all(&mut det, &seq);
    let gaps = det.inter_blink_intervals();
    assert!(gaps[0] > 11_000.0);
    assert_eq!(gaps.iter().filter(|&&g| g > 10_000.0).count(), 1);
}

#[test]
fn duration_is_time_c_above_half_not_hysteresis_span() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300)); // earOpen baseline ≈ 0.3
                                    // Piecewise-linear closure c(τ): slow 300 ms tail 0→0.45, steep to 1,
                                    // plateau, steep to 0.45, slow 400 ms tail back to 0.
                                    // c ≥ 0.5 from τ=301.8 to τ=451.8 → 150 ms.
    let pts: [(f64, f64); 6] = [
        (0.0, 0.0),
        (300.0, 0.45),
        (320.0, 1.0),
        (433.6, 1.0),
        (453.6, 0.45),
        (853.6, 0.0),
    ];
    let c_at = |tau: f64| -> f64 {
        if tau <= 0.0 || tau >= pts[pts.len() - 1].0 {
            return 0.0;
        }
        for i in 1..pts.len() {
            let (t0, c0) = pts[i - 1];
            let (t1, c1) = pts[i];
            if tau <= t1 {
                return c0 + (c1 - c0) * (tau - t0) / (t1 - t0);
            }
        }
        0.0
    };
    let f0 = plain_frame();
    det.push(&f0);
    let onset = f0.t;
    let mut seq = Vec::new();
    for _ in 0..40 {
        let mut f = plain_frame();
        let c = c_at(f.t - onset);
        with_closure(&mut f, c);
        seq.push(f);
    }
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.complete);
    assert!(
        (e.closed_ms - 150.0).abs() <= 34.0,
        "closedMs {}",
        e.closed_ms
    );
    assert_eq!(e.duration_ms, e.closed_ms);
    assert!(e.span_ms > 400.0, "span {} inflated by tails", e.span_ms);
    assert!(!e.long_closure);
}

#[test]
fn time_above_peak_half_for_incomplete_blinks() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300));
    let seq = closed_frames(&[0.48; 5]);
    let mut full = seq;
    full.extend(open(30));
    feed_all(&mut det, &full);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.peak < 0.5);
    assert!(e.closed_ms > 130.0);
    assert!(e.closed_ms < 200.0);
}

#[test]
fn real_clip_blink_profile_reports_short_duration() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let base = 0.31;
    feed_all(
        &mut det,
        &open_with(300, |f| {
            f.ear_l = base;
            f.ear_r = base;
        }),
    );
    let rows: [(f64, f64); 8] = [
        (0.082, 0.61),
        (0.037, 0.68),
        (0.036, 0.67),
        (0.035, 0.67),
        (0.033, 0.67),
        (0.096, 0.52),
        (0.178, 0.32),
        (0.25, 0.15),
    ];
    for (ear, blink) in rows {
        det.push(&frame(|f| {
            f.ear_l = ear;
            f.ear_r = ear;
            f.blink_l = blink;
            f.blink_r = blink;
        }));
    }
    feed_all(
        &mut det,
        &open_with(30, |f| {
            f.ear_l = base;
            f.ear_r = base;
        }),
    );
    assert_eq!(det.events.len(), 1);
    assert!(det.events[0].closed_ms < 300.0);
}

#[test]
fn caps_600ms_gap_of_missing_frames_inside_event() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300));
    feed_all(&mut det, &closed(3));
    let _ = open(18); // ~600 ms of frames dropped by quality gating
    let mut tail = closed(3);
    tail.extend(open(30));
    feed_all(&mut det, &tail);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.span_ms > 600.0);
    assert!(e.closed_ms >= 0.0);
    assert!(e.closed_ms <= e.span_ms + 200.0);
    // ~6 closed frames (~167 ms) + gap capped at 100 ms
    assert!(e.closed_ms < 350.0);
}

#[test]
fn ignores_pre_event_frame_2s_before_event_start() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300));
    let _ = open(60); // 2 s gated out → last pushed frame is 2 s before the blink
    let mut seq = closed(5);
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.closed_ms <= e.span_ms + 200.0);
    assert!(e.closed_ms > 100.0);
    assert!(e.closed_ms < 250.0);
}

#[test]
fn sensible_duration_for_peak_just_above_half() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300));
    // c > 0.255 (= peak/2) for ~150-180 ms; c ≥ 0.5 only at the peak frame
    let mut seq = closed_frames(&[0.3, 0.45, 0.51, 0.48, 0.45, 0.3, 0.1]);
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!((e.peak - 0.51).abs() < 0.005, "peak {}", e.peak);
    assert!(e.closed_ms > 80.0);
    assert!(e.closed_ms < 250.0);
}

#[test]
fn time_at_or_above_caps_intervals_and_skips_gap_crossings() {
    // both endpoints in, 600 ms apart → contributes the 100 ms cap
    assert_eq!(
        time_at_or_above(
            &[CcSample { t: 0.0, c: 1.0 }, CcSample { t: 600.0, c: 1.0 }],
            0.5,
            100.0
        ),
        100.0
    );
    // crossing across a 2 s gap → contributes nothing
    assert_eq!(
        time_at_or_above(
            &[CcSample { t: 0.0, c: 0.0 }, CcSample { t: 2000.0, c: 1.0 }],
            0.5,
            100.0
        ),
        0.0
    );
    // crossing within a normal interval → interpolated
    assert!(
        (time_at_or_above(
            &[CcSample { t: 0.0, c: 0.0 }, CcSample { t: 40.0, c: 1.0 }],
            0.5,
            100.0
        ) - 20.0)
            .abs()
            < 1e-9
    );
}

#[test]
fn splits_three_rapid_blinks_with_valleys() {
    let blink = [0.6, 1.0, 1.0, 1.0, 0.6];
    for valley_frames in [3usize, 10] {
        reset_clock();
        let mut det = BlinkDetector::new();
        feed_all(&mut det, &open(300));
        let mut cs: Vec<f64> = Vec::new();
        cs.extend(blink);
        cs.extend(std::iter::repeat_n(0.3, valley_frames));
        cs.extend(blink);
        cs.extend(std::iter::repeat_n(0.3, valley_frames));
        cs.extend(blink);
        cs.extend([0.3, 0.1]);
        let mut seq = closed_frames(&cs);
        seq.extend(open(60));
        feed_all(&mut det, &seq);
        assert_eq!(det.events.len(), 3, "valley {valley_frames} frames");
        assert!(det.events.iter().all(|e| e.complete && !e.long_closure));
        assert!(det.events.iter().all(|e| e.closed_ms < 250.0));
    }
}

#[test]
fn follows_drifting_rest_level_every_blink_found() {
    reset_clock();
    let mut det = BlinkDetector::new();
    let total = 60 * 30; // 60 s
    let blink_every = 60; // a blink every 2 s
    let profile = [0.6, 1.0, 1.0, 1.0, 0.6];
    let mut blink_starts: Vec<f64> = Vec::new();
    for i in 0..total {
        let r = 0.03 + (0.17 * i as f64) / total as f64; // resting c, blendshape-carried
        let k = i % blink_every;
        if i >= 300 && k < profile.len() {
            let mut f = plain_frame();
            with_closure(&mut f, r.max(profile[k]));
            if k == 0 {
                blink_starts.push(f.t);
            }
            det.push(&f);
        } else {
            det.push(&frame(|f| {
                f.blink_l = 2.0 * r;
                f.blink_r = 2.0 * r;
            }));
        }
    }
    assert_eq!(det.events.len(), blink_starts.len());
    for &t in &blink_starts {
        let hits = det
            .events
            .iter()
            .filter(|e| e.start <= t + 40.0 && e.end >= t)
            .count();
        assert_eq!(hits, 1, "blink at {}", t.round());
    }
    assert!(!det.events.iter().any(|e| e.long_closure));
    // Late events are measured against the drifted rest level.
    assert!(det.events.last().unwrap().rest > 0.15);
}

#[test]
fn ignores_prominence_wiggle_on_elevated_rest() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(
        &mut det,
        &open_with(300, |f| {
            f.blink_l = 0.4;
            f.blink_r = 0.4;
        }),
    ); // rest c ≈ 0.2
    let mut seq = open_with(4, |f| {
        f.blink_l = 0.7;
        f.blink_r = 0.7;
    }); // c ≈ 0.35
    seq.extend(open_with(60, |f| {
        f.blink_l = 0.4;
        f.blink_r = 0.4;
    }));
    feed_all(&mut det, &seq);
    const { assert!(0.15 < config::PROM_START) };
    assert_eq!(det.events.len(), 0);
}

#[test]
fn keeps_real_1_2s_closure_as_one_long_closure() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300));
    let cs: Vec<f64> = (0..36)
        .map(|i| if i % 2 == 1 { 0.9 } else { 1.0 })
        .collect();
    let mut seq = closed_frames(&cs);
    seq.extend(open(60));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    let e = &det.events[0];
    assert!(e.complete);
    assert!(e.long_closure);
    assert!(e.closed_ms > 1000.0);
}

#[test]
fn ignores_zero_closure_baseline_drift() {
    reset_clock();
    let mut det = BlinkDetector::new();
    feed_all(&mut det, &open(300)); // 10 s of open frames → earOpen ≈ 0.3
    let mut seq = closed(4);
    seq.extend(open(30));
    feed_all(&mut det, &seq);
    assert_eq!(det.events.len(), 1);
    assert!(det.events[0].complete);
}
