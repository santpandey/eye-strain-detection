"""Port of the session/threshold/eval behaviors in tests/session.test.ts."""

import pytest

from blinkwell.config import CFG
from blinkwell.eval import match_blinks
from blinkwell.session import QuickCheckAggregator, assess_confidence, poisson_interval
from blinkwell.thresholds import assess, overall_verdict

from helpers import frame, make_result, reset_clock


class TestPoissonInterval:
    def test_n10(self):
        r = poisson_interval(10)
        assert r["lower"] == pytest.approx(4.8, rel=0.02)
        assert r["upper"] == pytest.approx(18.39, rel=0.02)

    def test_n0(self):
        assert poisson_interval(0)["lower"] == 0


GOOD = {
    "qualityMs": 90_000,
    "qualityPct": 95,
    "fpsMean": 29,
    "glarePct": 0,
    "backlitPct": 0,
    "discardPct": 0,
    "candidateCount": 0,
}


class TestAssessConfidence:
    def test_high(self):
        r = assess_confidence(dict(GOOD))
        assert r["confidence"] == "high"
        assert r["reasons"] == []

    def test_medium_with_reasons(self):
        i = dict(GOOD, qualityMs=65_000, fpsMean=20)
        r = assess_confidence(i)
        assert r["confidence"] == "medium"
        assert len(r["reasons"]) > 0
        assert any("usable footage" in x["text"] for x in r["reasons"])
        assert any("fps" in x["text"] for x in r["reasons"])
        assert all(len(x["fix"]) > 0 for x in r["reasons"])

    def test_low_below_medium_floors(self):
        r = assess_confidence(dict(GOOD, qualityMs=10_000))
        assert r["confidence"] == "low"

    def test_glare_backlit_reasons(self):
        r = assess_confidence(dict(GOOD, glarePct=22, backlitPct=30))
        assert any("Reflections" in x["text"] for x in r["reasons"])
        assert any("backlight" in x["text"] for x in r["reasons"])

    def test_abstain_on_high_discards_with_enough_candidates(self):
        r = assess_confidence(dict(GOOD, discardPct=55, candidateCount=20))
        assert r["confidence"] == "low"
        assert any("discarded" in x["text"] for x in r["reasons"])

    def test_no_abstain_on_too_few_candidates(self):
        r = assess_confidence(dict(GOOD, discardPct=55, candidateCount=3))
        assert r["confidence"] != "low"

    def test_scales_floor_to_planned_target(self):
        # The 60 s monitor window case: the absolute 80 s floor was unreachable.
        r = assess_confidence(dict(GOOD, qualityMs=62_000, targetMs=60_000))
        assert r["confidence"] == "high"
        assert r["reasons"] == []

    def test_scaled_floor_cited_in_reason(self):
        r = assess_confidence(dict(GOOD, qualityMs=58_000, targetMs=60_000))
        assert r["confidence"] == "low"
        assert any("60 s+ recommended" in x["text"] for x in r["reasons"])

    def test_absolute_floors_when_no_target(self):
        r = assess_confidence(dict(GOOD, qualityMs=62_000))
        assert r["confidence"] == "medium"
        assert any("80 s+ recommended" in x["text"] for x in r["reasons"])

    def test_medium_reachable_under_60s_target(self):
        r = assess_confidence(dict(GOOD, qualityMs=45_000, targetMs=45_000))
        assert r["confidence"] == "high"


CORE = {
    "blinkRate": 14,
    "incompleteRatio": 0.1,
    "meanBlinkMs": 150,
    "meanReopenFrac": 0.6,
    "perclos": 0.01,
    "maxIbiMs": 4000,
    "distanceCm": 55,
    "luma": 120,
}


class TestMetricMinimums:
    def test_mean_blink_na_below_5(self):
        assert assess(dict(CORE), 4)["statuses"]["meanBlinkMs"] == "na"
        assert assess(dict(CORE), 5)["statuses"]["meanBlinkMs"] != "na"

    def test_incomplete_na_below_8(self):
        assert assess(dict(CORE), 7)["statuses"]["incompleteRatio"] == "na"
        assert assess(dict(CORE), 8)["statuses"]["incompleteRatio"] == "good"

    def test_distance_na_for_file(self):
        assert assess(dict(CORE), 10, False)["statuses"]["distanceCm"] == "na"
        cam = assess(dict(CORE), 10, True)
        assert cam["statuses"]["distanceCm"] == "good"
        f = assess(dict(CORE, distanceCm=30), 10, False)
        assert f["statuses"]["distanceCm"] == "na"
        assert all("cm from the screen" not in t for t in f["tips"])

    def test_reopen_frac_tiers(self):
        assert assess(dict(CORE), 4)["statuses"]["reopenFrac"] == "na"
        assert assess(dict(CORE), 5)["statuses"]["reopenFrac"] == "good"
        assert assess(dict(CORE, meanReopenFrac=0.8), 5)["statuses"]["reopenFrac"] == "watch"
        assert assess(dict(CORE, meanReopenFrac=0.9), 5)["statuses"]["reopenFrac"] == "high"


class TestOverallVerdict:
    def st(self, c, n=10):
        return assess(c, n)["statuses"]

    def test_low_blink_rate_is_context_not_tiredness(self):
        assert overall_verdict(self.st(dict(CORE, blinkRate=3))) == "Screen-focus strain signs"

    def test_fatigue_signals(self):
        assert overall_verdict(self.st(dict(CORE, meanBlinkMs=500))) == "Your eyes look tired"
        assert overall_verdict(self.st(dict(CORE, incompleteRatio=0.7))) == "Your eyes look tired"
        assert overall_verdict(self.st(dict(CORE, meanReopenFrac=0.9))) == "Your eyes look tired"
        assert overall_verdict(self.st(dict(CORE, perclos=0.2))) == "Your eyes look tired"

    def test_fatigue_outranks_context(self):
        assert overall_verdict(self.st(dict(CORE, blinkRate=3, meanBlinkMs=350))) == (
            "A few things to watch"
        )

    def test_all_clear(self):
        assert overall_verdict(self.st(dict(CORE))) == "Looking good"


class TestMatchBlinks:
    @staticmethod
    def ev(s, d=150):
        return {"start": s, "end": s + d}

    def test_exact(self):
        r = match_blinks([self.ev(1000), self.ev(3000)], [1050, 3050], 1)
        assert r["tp"] == 2
        assert r["f1"] == 1

    def test_tolerance_edges(self):
        tol = CFG.matchTolMs
        assert match_blinks([self.ev(1000)], [1000 - tol], 1)["tp"] == 1
        assert match_blinks([self.ev(1000)], [1000 + 150 + tol], 1)["tp"] == 1

    def test_outside_tolerance(self):
        tol = CFG.matchTolMs
        r = match_blinks([self.ev(1000)], [1000 - tol - 1], 1)
        assert r["tp"] == 0 and r["fp"] == 1 and r["fn"] == 1
        assert r["precision"] == 0 and r["recall"] == 0

    def test_rate_error(self):
        r = match_blinks([self.ev(1000), self.ev(2000), self.ev(3000)], [1000], 1)
        assert r["rateErrorPerMin"] == pytest.approx(2)


class TestLowFps:
    def test_3fps_stream(self):
        """3 fps: frames are gated, so the dt cap cannot accrue quality time."""
        reset_clock()
        agg = QuickCheckAggregator()
        for i in range(30):
            f = frame()
            f.t = 1000 + i * (1000 / 3)  # 10 s at 3 fps
            agg.push(f)
        # Only the frames before the first fps judgement (~1 s) reach the
        # detector; each contributes at most dtCapMs.
        assert agg.detector.quality_ms <= 3 * CFG.dtCapMs
        r = agg.result()
        assert r["qualityPct"] < 5
        assert 2.8 < r["fpsMean"] < 3.2


class TestAggregatorEndToEnd:
    def test_result_shape(self):
        reset_clock()
        agg = QuickCheckAggregator()
        from helpers import closed, open as _open

        for _ in range(6):
            for f in _open(174) + closed(5):
                agg.push(f)
        r = agg.result("camera")
        assert r["schemaVersion"] == 2
        assert r["source"] == "camera"
        assert r["completeBlinks"] + r["incompleteBlinks"] == 6
        assert r["qualityMs"] > 0
        assert r["statuses"]["blinkRate"] in ("good", "watch", "high")

    def test_trace_strips_eye_contour(self):
        reset_clock()
        agg = QuickCheckAggregator()
        agg.trace_enabled = True
        f = frame({"eyeContour": [0.1, 0.2] * 12})
        agg.push(f)
        assert agg.trace_frames[0]["eyeContour"] == []
        assert agg.trace_diag[0]["ok"] is True
