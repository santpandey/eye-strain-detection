"""Port of the key BlinkDetector behaviors in tests/blink.test.ts."""

import math

import pytest

from eyefd.blink import BlinkDetector, time_at_or_above
from eyefd.config import CFG
from eyefd.quality import QualityCtx

from helpers import (
    closed,
    feed_all,
    frame,
    half_closed,
    noise,
    open,
    reset_clock,
)


@pytest.fixture(autouse=True)
def _reset():
    reset_clock()


def with_closure(f, c):
    """Set symmetric ear/blink so the detector's closure c equals `c` (earOpen 0.3)."""
    ear = 0.3 * (1 - 0.6 * c)  # EAR term: 0.5·(1−ear/0.3)/0.6 = 0.5·c
    f.earL = ear
    f.earR = ear
    f.blinkL = c
    f.blinkR = c
    return f


def test_ten_normal_150ms_blinks_all_complete():
    det = BlinkDetector()
    seq = []
    for _ in range(10):
        seq += open(174)  # ~5.8 s of open eyes between blinks
        seq += closed(5)  # ~167 ms closure
    seq += open(10)
    feed_all(det, seq)
    det.finish()  # last event's post-window isn't covered → release unchecked
    assert len(det.events) == 10
    assert all(e.complete for e in det.events)
    assert all(100 < e.durationMs < 250 for e in det.events)
    rate = len(det.events) / (det.quality_ms / 60000)
    assert 9 < rate < 11


def test_half_closures_are_incomplete():
    det = BlinkDetector()
    feed_all(det, open(60) + half_closed(5) + open(60))
    assert len(det.events) == 1
    e = det.events[0]
    assert 0.45 <= e.peak < 0.8
    assert not e.complete


def test_close_reopen_split_at_peak():
    det = BlinkDetector()
    seq = (
        open(60)
        + [with_closure(frame(), 1.0)]
        + [with_closure(frame(), 1.0)]
        + [with_closure(frame(), 0.8)]
        + [with_closure(frame(), 0.6)]
        + [with_closure(frame(), 0.4)]
        + [with_closure(frame(), 0.2)]
        + open(60)
    )
    feed_all(det, seq)
    det.finish()
    assert len(det.events) == 1
    e = det.events[0]
    assert e.reopenMs > e.closeMs
    assert 0 < e.closeMs + e.reopenMs <= e.spanMs + 2 * CFG.dtCapMs


def test_long_closure_800ms():
    det = BlinkDetector()
    feed_all(det, open(60) + closed(24) + open(60))
    assert len(det.events) == 1
    assert det.events[0].complete
    assert det.events[0].longClosure


def test_perclos_two_second_closure():
    det = BlinkDetector()
    feed_all(det, open(30 * 30) + closed(2 * 30) + open(30))
    # Quality time ≈ 32 s; closed fraction ≈ 2/32.
    assert 0.05 < det.perclos < 0.08


def test_nonquality_frames_gated():
    det = BlinkDetector()
    ctx = QualityCtx()

    def feed(seq):
        for f in seq:
            if ctx.check(f).ok:
                det.push(f)

    feed(open(30))
    before = det.quality_ms
    feed(open(30, {"yaw": 30}))
    assert det.quality_ms == before
    # A "blink" hidden inside bad frames is not seen.
    feed([_over(f, {"yaw": 30}) for f in closed(5)] + open(30))
    assert len(det.events) == 0


def _over(f, over):
    for k, v in over.items():
        setattr(f, k, v)
    return f


def test_lookdown_spike_at_onset_kept():
    det = BlinkDetector()
    feed_all(det, open(60))
    # lookDown spikes around the blink itself (lid drop reads as gaze-down)
    feed_all(det, open(3, {"lookDown": 0.7}))
    feed_all(det, closed(5, {"lookDown": 0.7}))
    feed_all(det, open(60))
    assert len(det.events) == 1
    assert det.gaze_down_discards == 0


def test_sustained_gaze_down_discards():
    det = BlinkDetector()
    feed_all(det, open(60))
    feed_all(det, closed(5))
    # user keeps looking down after the lids reopen: rest 0 → post ≈ 0.35
    feed_all(det, open(60, {"lookDown": 0.35}))
    assert len(det.events) == 0
    assert det.gaze_down_discards == 1


def test_high_resting_lookdown_kept():
    det = BlinkDetector()
    feed_all(det, open(60, {"lookDown": 0.6}))  # this user's rest level
    feed_all(det, closed(5, {"lookDown": 0.6}))
    feed_all(det, open(60, {"lookDown": 0.6}))
    assert len(det.events) == 1
    assert det.gaze_down_discards == 0


def test_neighbor_guard_keeps_first_blink_when_next_opens_inside_post_window():
    """Neighbor-guard fix: an event opening inside (or just after) a pending
    event's post window makes the gaze check unobservable → accept unchecked."""
    det = BlinkDetector()
    feed_all(det, open(60))
    feed_all(det, closed(5))  # blink 1
    # Blink 2's detect-start lands inside blink 1's post window (+pad). The
    # post-window lookDown is high (would discard), but the guard accepts.
    feed_all(det, open(4, {"lookDown": 0.9}))
    feed_all(det, closed(5))  # blink 2 opens ~t1+100–350 ms
    feed_all(det, open(60, {"lookDown": 0.9}))
    det.finish()
    # Blink 1 is kept: its post-window lookDown (0.9) is unobservable because
    # blink 2's start falls inside postEnd + gazeNeighborPadMs. Blink 2 is then
    # gaze-discarded (its own post window is all lookDown 0.9 vs rest 0).
    assert len(det.events) == 1
    assert det.gaze_down_discards == 1
    assert 2000 < det.events[0].start < 2100


def test_pending_event_flushed_at_end_of_stream():
    det = BlinkDetector()
    feed_all(det, open(60))
    feed_all(det, closed(5))
    det.finish()  # no post-window frames: accepted unchecked
    assert len(det.events) == 1
    assert det.gaze_down_discards == 0


def test_asymmetric_closure_discarded():
    det = BlinkDetector()
    feed_all(det, open(60))
    # left eye closes, right stays open; blink blendshape pushes c past start
    feed_all(det, open(5, {"earL": 0, "blinkL": 0.7, "blinkR": 0.7}))
    feed_all(det, open(60))
    assert len(det.events) == 0
    assert det.asymmetric_discards == 1


def test_sub_promstart_noise_wiggles_discarded():
    det = BlinkDetector()
    feed_all(det, open(60) + noise(4) + open(60))
    assert len(det.events) == 0


def test_inter_blink_gaps_over_10s():
    det = BlinkDetector()
    feed_all(
        det,
        open(30)
        + closed(5)  # blink 1
        + open(30 * 12)  # 12 s gap
        + closed(5)  # blink 2
        + open(30 * 5)
        + closed(5)  # blink 3, gap 5 s
        + open(30),
    )
    assert len(det.events) == 3
    gaps = det.inter_blink_intervals
    # leading ~1 s, 12 s, 5 s, trailing ~1 s
    assert len(gaps) == 4
    assert gaps[1] > 10_000
    assert len([g for g in gaps if g > 10_000]) == 1


def test_no_blinks_whole_span_is_one_gap():
    det = BlinkDetector()
    feed_all(det, open(15 * 30))
    gaps = det.inter_blink_intervals
    assert len(gaps) == 1
    assert 14_000 < gaps[0] <= 15_000


def test_leading_gap_before_first_blink():
    det = BlinkDetector()
    feed_all(det, open(30 * 12) + closed(5) + open(30 * 5))
    gaps = det.inter_blink_intervals
    assert gaps[0] > 11_000
    assert len([g for g in gaps if g > 10_000]) == 1


def test_duration_measured_above_half_peak_not_span():
    det = BlinkDetector()
    feed_all(det, open(300))
    # Piecewise-linear closure profile c(τ), τ in ms from blink onset.
    pts = [(0, 0), (300, 0.45), (320, 1), (433.6, 1), (453.6, 0.45), (853.6, 0)]

    def c_at(tau):
        if tau <= 0 or tau >= pts[-1][0]:
            return 0.0
        for i in range(1, len(pts)):
            t0, c0 = pts[i - 1]
            t1, c1 = pts[i]
            if tau <= t1:
                return c0 + ((c1 - c0) * (tau - t0)) / (t1 - t0)
        return 0.0

    f0 = frame()
    det.push(f0)
    onset = f0.t
    seq = []
    for _ in range(40):
        f = frame()
        seq.append(with_closure(f, c_at(f.t - onset)))
    feed_all(det, seq + open(30))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.complete
    assert abs(e.closedMs - 150) <= 34
    assert e.durationMs == e.closedMs
    assert e.spanMs > 400  # old metric inflated by tails
    assert not e.longClosure


def test_incomplete_peak_below_half_uses_half_peak_level():
    det = BlinkDetector()
    feed_all(det, open(300))
    seq = [with_closure(frame(), 0.48) for _ in range(5)]
    feed_all(det, seq + open(30))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.peak < 0.5
    assert 130 < e.closedMs < 200


def test_gap_inside_event_capped():
    det = BlinkDetector()
    feed_all(det, open(300))
    feed_all(det, closed(3))
    open(18)  # ~600 ms of frames dropped by quality gating (never pushed)
    feed_all(det, closed(3) + open(30))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.spanMs > 600
    assert 0 <= e.closedMs <= e.spanMs + 200
    # ~6 closed frames (~167 ms) + gap capped at 100 ms
    assert e.closedMs < 350


def test_preevent_frame_2s_earlier_ignored():
    det = BlinkDetector()
    feed_all(det, open(300))
    open(60)  # 2 s gated out → last pushed frame is 2 s before the blink
    feed_all(det, closed(5) + open(30))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.closedMs <= e.spanMs + 200
    assert 100 < e.closedMs < 250


def test_peak_just_above_half_no_slivers():
    det = BlinkDetector()
    feed_all(det, open(300))
    cs = [0.3, 0.45, 0.51, 0.48, 0.45, 0.3, 0.1]
    feed_all(det, [with_closure(frame(), c) for c in cs] + open(30))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.peak == pytest.approx(0.51, abs=0.01)
    assert 80 < e.closedMs < 250


def test_time_at_or_above_caps_and_skips_gap_crossings():
    # both endpoints in, 600 ms apart → contributes the 100 ms cap
    assert time_at_or_above([{"t": 0, "c": 1}, {"t": 600, "c": 1}], 0.5, 100) == 100
    # crossing across a 2 s gap → contributes nothing
    assert time_at_or_above([{"t": 0, "c": 0}, {"t": 2000, "c": 1}], 0.5, 100) == 0
    # crossing within a normal interval → interpolated
    assert time_at_or_above([{"t": 0, "c": 0}, {"t": 40, "c": 1}], 0.5, 100) == pytest.approx(20)


def test_three_rapid_blinks_split_at_valley():
    blink = [0.6, 1, 1, 1, 0.6]
    for valley_frames in (3, 10):
        reset_clock()
        det = BlinkDetector()
        feed_all(det, open(300))
        valley = [0.3] * valley_frames
        cs = blink + valley + blink + valley + blink + [0.3, 0.1]
        feed_all(det, [with_closure(frame(), c) for c in cs] + open(60))
        assert len(det.events) == 3, f"valley {valley_frames} frames"
        assert all(e.complete and not e.longClosure for e in det.events)
        assert all(e.closedMs < 250 for e in det.events)


def test_rest_level_drift_every_blink_found_none_merged():
    det = BlinkDetector()
    total = 60 * 30  # 60 s
    blink_every = 60  # a blink every 2 s
    profile = [0.6, 1, 1, 1, 0.6]
    blink_starts = []
    for i in range(total):
        r = 0.03 + (0.17 * i) / total  # resting c, carried by the blendshape
        k = i % blink_every
        if i >= 300 and k < len(profile):
            f = with_closure(frame(), max(r, profile[k]))
            if k == 0:
                blink_starts.append(f.t)
            det.push(f)
        else:
            det.push(frame({"blinkL": 2 * r, "blinkR": 2 * r}))
    assert len(det.events) == len(blink_starts)
    for t in blink_starts:
        hits = [e for e in det.events if e.start <= t + 40 and e.end >= t]
        assert len(hits) == 1, f"blink at {round(t)}"
    assert not any(e.longClosure for e in det.events)
    # Late events are measured against the drifted rest level.
    assert det.events[-1].rest > 0.15


def test_elevated_rest_wiggle_ignored():
    det = BlinkDetector()
    feed_all(det, open(300, {"blinkL": 0.4, "blinkR": 0.4}))  # rest c ≈ 0.2
    feed_all(
        det,
        open(4, {"blinkL": 0.7, "blinkR": 0.7})  # c ≈ 0.35
        + open(60, {"blinkL": 0.4, "blinkR": 0.4}),
    )
    assert 0.15 < CFG.promStart
    assert len(det.events) == 0


def test_real_1_2s_closure_single_long_event():
    det = BlinkDetector()
    feed_all(det, open(300))
    cs = [0.9 if i % 2 else 1.0 for i in range(36)]
    feed_all(det, [with_closure(frame(), c) for c in cs] + open(60))
    assert len(det.events) == 1
    e = det.events[0]
    assert e.complete
    assert e.longClosure
    assert e.closedMs > 1000


def test_zero_closure_baseline_drift_uses_history():
    det = BlinkDetector()
    feed_all(det, open(300))  # 10 s of steady open frames → earOpen ≈ 0.3
    feed_all(det, closed(4) + open(30))
    assert len(det.events) == 1
    assert det.events[0].complete


def test_real_clip_blink_profile_short_duration():
    det = BlinkDetector()
    base = 0.31
    feed_all(det, open(300, {"earL": base, "earR": base}))
    rows = [
        (0.082, 0.61),
        (0.037, 0.68),
        (0.036, 0.67),
        (0.035, 0.67),
        (0.033, 0.67),
        (0.096, 0.52),
        (0.178, 0.32),
        (0.25, 0.15),
    ]
    for ear_v, blink in rows:
        det.push(frame({"earL": ear_v, "earR": ear_v, "blinkL": blink, "blinkR": blink}))
    feed_all(det, open(30, {"earL": base, "earR": base}))
    assert len(det.events) == 1
    assert det.events[0].closedMs < 300
