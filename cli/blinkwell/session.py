"""QuickCheckAggregator -> QuickCheckResult dict + confidence.

Keep in sync with src/lib/analysis/session.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import replace
from datetime import datetime, timezone

from .blink import BlinkDetector
from .config import CFG
from .features import FrameFeatures, estimate_distance_cm
from .quality import QualityCtx
from .thresholds import assess


def _iso_now() -> str:
    """new Date().toISOString() equivalent: '…T…+00:00' → '…Z', ms precision."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def poisson_interval(n: int) -> dict:
    """Wilson–Hilferty Poisson 95% interval for a count."""
    z = 1.96
    lower = 0.0 if n == 0 else n * math.pow(1 - 1 / (9 * n) - z / (3 * math.sqrt(n)), 3)
    upper = (n + 1) * math.pow(
        1 - 1 / (9 * (n + 1)) + z / (3 * math.sqrt(n + 1)), 3
    )
    return {"lower": lower, "upper": upper}


class QuickCheckAggregator:
    """Aggregates frames into a QuickCheckResult. Pure and synchronous."""

    def __init__(self) -> None:
        self.detector = BlinkDetector()
        self.quality = QualityCtx()
        # Dev-mode trace of every processed frame (eyeContour stripped).
        self.trace_frames: list = []
        # Dev-mode per-frame quality verdicts, aligned with trace_frames.
        self.trace_diag: list = []
        self.trace_enabled = False

        self.started_at: str | None = None
        self._first_t = None
        self._last_t = None
        self._distances: list = []
        self._lumas: list = []
        self._squints: list = []
        self._jaw_since = None
        self._yawn_count = 0
        self._glare_frames = 0
        self._backlit_frames = 0
        self._face_frames = 0

    def begin(self) -> None:
        self.started_at = _iso_now()

    def push(self, f: FrameFeatures) -> bool:
        """Feed one frame; returns whether it passed the quality gates
        (mirrors the Rust aggregator's bool return — monitor uses it for
        usable-time capture)."""
        if self.started_at is None:
            self.begin()
        if self.trace_enabled:
            self.trace_frames.append(replace(f, eyeContour=[]).to_dict())
        if self._first_t is None:
            self._first_t = f.t
        self._last_t = f.t

        v = self.quality.check(f)
        if self.trace_enabled:
            self.trace_diag.append(
                {
                    "ok": v.ok,
                    "reasons": list(v.reasons),
                    "glare": v.glare,
                    "backlit": v.backlit,
                    "fps": v.fps,
                }
            )
        if f.face:
            self._face_frames += 1
            if v.glare:
                self._glare_frames += 1
            if v.backlit:
                self._backlit_frames += 1
        if not v.ok:
            self._jaw_since = None
            return False
        self.detector.push(f)
        self._lumas.append(f.faceLuma)
        self._squints.append((f.squintL + f.squintR) / 2)
        if f.irisPx > 0:
            self._distances.append(estimate_distance_cm(f.irisPx, f.frameW))

        if f.jawOpen > 0.5:
            if self._jaw_since is None:
                self._jaw_since = f.t
            elif f.t - self._jaw_since >= 1500:
                self._yawn_count += 1
                self._jaw_since = None
        else:
            self._jaw_since = None
        return True

    @property
    def fps_mean(self) -> float:
        s = self.quality.fps_samples
        return sum(s) / len(s) if s else 0.0

    def result(self, source: str = "camera", target_ms: float = 0.0) -> dict:
        d = self.detector
        d.finish()
        events = d.events
        complete = [e for e in events if e.complete]
        incomplete = [e for e in events if not e.complete]
        quality_min = d.quality_ms / 60000
        ibis = d.inter_blink_intervals
        duration_ms = 0.0 if self._first_t is None or self._last_t is None else self._last_t - self._first_t
        quality_pct = (d.quality_ms / duration_ms) * 100 if duration_ms > 0 else 0.0
        interval = poisson_interval(len(events))
        glare_pct = (self._glare_frames / self._face_frames) * 100 if self._face_frames > 0 else 0.0
        backlit_pct = (
            (self._backlit_frames / self._face_frames) * 100 if self._face_frames > 0 else 0.0
        )
        fps_mean = self.fps_mean

        core = {
            "blinkRate": len(events) / quality_min if quality_min > 0 else 0.0,
            "blinkRateLow": interval["lower"] / quality_min if quality_min > 0 else 0.0,
            "blinkRateHigh": interval["upper"] / quality_min if quality_min > 0 else 0.0,
            "completeBlinks": len(complete),
            "incompleteBlinks": len(incomplete),
            "incompleteRatio": len(incomplete) / len(events) if len(events) > 0 else 0.0,
            "meanBlinkMs": _mean([e.durationMs for e in events]),
            "meanReopenFrac": _mean(
                [
                    e.reopenMs / (e.closeMs + e.reopenMs)
                    for e in events
                    if e.closeMs + e.reopenMs > 0
                ]
            ),
            "longClosures": len([e for e in events if e.longClosure]),
            "perclos": d.perclos,
            "maxIbiMs": max(ibis) if ibis else 0.0,
            "ibiOver10s": len([g for g in ibis if g > CFG.ibiWatchMs]),
            "distanceCm": _median(self._distances),
            "luma": _median(self._lumas),
            "squint": _mean(self._squints),
            "yawns": self._yawn_count,
            "fpsMean": fps_mean,
            "glarePct": glare_pct,
            "backlitPct": backlit_pct,
            "gazeDownDiscards": d.gaze_down_discards,
            "asymmetricDiscards": d.asymmetric_discards,
        }
        # distanceAvailable: only a video file lacks a live camera's iris metric.
        assessed = assess(core, len(events), source != "file")
        conf = assess_confidence(
            {
                "qualityMs": d.quality_ms,
                "qualityPct": quality_pct,
                "fpsMean": fps_mean,
                "glarePct": glare_pct,
                "backlitPct": backlit_pct,
                "discardPct": d.discard_pct,
                "candidateCount": d.candidate_count,
                "targetMs": target_ms,
            }
        )
        return {
            "schemaVersion": 2,
            "id": str(uuid.uuid4()),
            "startedAt": self.started_at if self.started_at is not None else _iso_now(),
            "durationMs": duration_ms,
            "qualityMs": d.quality_ms,
            "qualityPct": quality_pct,
            **core,
            "confidence": conf["confidence"],
            "confidenceReasons": conf["reasons"],
            "tips": assessed["tips"],
            "statuses": assessed["statuses"],
            "source": source,
        }


def _js_round(x: float) -> int:
    """Math.round — ties toward +∞ (not Python's banker's rounding)."""
    return math.floor(x + 0.5)


def assess_confidence(i: dict) -> dict:
    # The usable-footage floors scale to the planned capture length: a 60 s
    # monitor window can never reach the absolute 80 s floor, so the bar
    # becomes "as much usable time as this window could yield".
    target = i.get("targetMs", 0.0)
    high_ms = min(CFG.confHighQualityMs, target) if target > 0 else CFG.confHighQualityMs
    med_ms = min(CFG.confMedQualityMs, target) if target > 0 else CFG.confMedQualityMs
    reasons: list = []
    if i["qualityMs"] < high_ms:
        reasons.append(
            {
                "text": f"Only {_js_round(i['qualityMs'] / 1000)} s of usable footage ({_js_round(high_ms / 1000)} s+ recommended)",
                "fix": "Keep your face in frame and well lit for the whole check.",
            }
        )
    if i["qualityPct"] < CFG.confHighQualityPct:
        reasons.append(
            {
                "text": f"{_js_round(i['qualityPct'])}% of frames were usable ({CFG.confHighQualityPct}%+ recommended)",
                "fix": "Hold still and face the camera so fewer frames are dropped.",
            }
        )
    if i["fpsMean"] < CFG.confHighFps:
        reasons.append(
            {
                "text": f"Frame rate averaged {_js_round(i['fpsMean'])} fps ({CFG.confHighFps}+ recommended)",
                "fix": "Add light, or close other apps using the camera/CPU.",
            }
        )
    if i["glarePct"] > CFG.confHighGlarePct:
        reasons.append(
            {
                "text": f"Reflections on glasses in {_js_round(i['glarePct'])}% of frames",
                "fix": "Tilt your glasses slightly or move the light source off to the side.",
            }
        )
    if i["backlitPct"] > CFG.confHighBacklitPct:
        reasons.append(
            {
                "text": f"Strong backlight in {_js_round(i['backlitPct'])}% of frames",
                "fix": "Face a window or lamp so the light falls on your face.",
            }
        )
    discard_abstain = (
        i["candidateCount"] >= CFG.maxDiscardMinCandidates
        and i["discardPct"] > CFG.maxDiscardPct
    )
    if discard_abstain:
        reasons.append(
            {
                "text": f"{_js_round(i['discardPct'])}% of {i['candidateCount']} blink candidates were discarded (gaze-down or one-sided closures)",
                "fix": "Face the camera squarely and keep both eyes in view, then try again.",
            }
        )
    elif i["discardPct"] > CFG.confHighDiscardPct:
        reasons.append(
            {
                "text": f"{_js_round(i['discardPct'])}% of blink candidates were discarded",
                "fix": "Look straight at the screen and keep both eyes visible.",
            }
        )
    if len(reasons) == 0:
        return {"confidence": "high", "reasons": reasons}
    if discard_abstain:
        return {"confidence": "low", "reasons": reasons}

    medium = (
        i["qualityMs"] >= med_ms
        and i["qualityPct"] >= CFG.confMedQualityPct
        and i["fpsMean"] >= CFG.confMedFps
    )
    return {"confidence": "medium" if medium else "low", "reasons": reasons}


def _median(xs: list) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def _mean(xs: list) -> float:
    return sum(xs) / len(xs) if xs else 0.0
