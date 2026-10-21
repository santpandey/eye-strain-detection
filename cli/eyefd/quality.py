"""QualityCtx: frame gates (noFace/headPose/dark/lowFps/motion).

Keep in sync with src/lib/analysis/quality.ts — this is a 1:1 port.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from .config import CFG
from .features import FrameFeatures

REASONS = ("noFace", "headPose", "dark", "lowFps", "motion")


@dataclass
class QualityVerdict:
    ok: bool
    reasons: list  # subset of REASONS
    # Non-gating signals, for guidance + confidence.
    glare: bool
    backlit: bool
    fps: float


class QualityCtx:
    """Stateful quality gate. Tracks the processed-frame timestamps for rolling
    fps (on the frame's own `t` timeline, so file sources work) and the previous
    nose position for motion."""

    def __init__(self) -> None:
        self._ts: deque = deque()
        self._prev_nose = None
        self._prev_t = None
        self._first_t = None
        self.fps_samples: list = []
        # Verdict of the most recent check.
        self.last: QualityVerdict | None = None

    def check(self, f: FrameFeatures) -> QualityVerdict:
        # Rolling processed fps over the last window. Judged once the window
        # holds lowFpsMinFrames frames OR covers lowFpsMinSpanMs, whichever comes
        # first — so very slow streams (a few fps) are still caught.
        if self._first_t is None:
            self._first_t = f.t
        self._ts.append(f.t)
        cutoff = f.t - CFG.lowFpsWindowMs
        while self._ts and self._ts[0] < cutoff:
            self._ts.popleft()
        n = len(self._ts)
        span_ms = self._ts[n - 1] - self._ts[0] if n > 1 else 0.0
        # Time covered by the window (≥ frame span; also counts a lone frame).
        window_ms = min(CFG.lowFpsWindowMs, f.t - self._first_t)
        judged = n >= CFG.lowFpsMinFrames or max(span_ms, window_ms) >= CFG.lowFpsMinSpanMs
        if n >= 2 and span_ms > 0:
            fps = ((n - 1) * 1000) / span_ms
        else:
            fps = (n * 1000) / window_ms if judged and window_ms > 0 else 0.0
        if judged:
            self.fps_samples.append(fps)

        reasons: list = []
        if not f.face:
            reasons.append("noFace")
        else:
            if abs(f.yaw) > CFG.headPoseDeg or abs(f.pitch) > CFG.headPoseDeg:
                reasons.append("headPose")
            if f.faceLuma < CFG.faceLumaMin:
                reasons.append("dark")
            # Motion: nose speed in interocular-widths per second.
            if self._prev_nose is not None and self._prev_t is not None and f.interocularPx > 0:
                dt = (f.t - self._prev_t) / 1000
                if dt > 0:
                    iow = f.interocularPx / f.frameW
                    speed = (
                        math.hypot(f.nose[0] - self._prev_nose[0], f.nose[1] - self._prev_nose[1])
                        / iow
                        / dt
                    )
                    if speed > CFG.motionMaxIowPerSec:
                        reasons.append("motion")
            self._prev_nose = f.nose
            self._prev_t = f.t
        if judged and fps < CFG.lowFpsMin:
            reasons.append("lowFps")

        self.last = QualityVerdict(
            ok=len(reasons) == 0,
            reasons=reasons,
            glare=max(f.glare[0], f.glare[1]) > CFG.glareFrac,
            backlit=bool(f.face) and f.frameLuma - f.faceLuma > CFG.backlitDelta,
            fps=fps,
        )
        return self.last


def guidance_for(v: QualityVerdict | None, fallback: str) -> str:
    """Guidance lines in priority order for the align phase / capture pause."""
    if v is None:
        return "Looking for your face…"
    if "noFace" in v.reasons:
        return "Looking for your face…"
    if "headPose" in v.reasons:
        return "Face the screen"
    if "dark" in v.reasons:
        return "More light on your face needed"
    if v.backlit:
        return "Light is behind you — face a window or lamp"
    if "lowFps" in v.reasons:
        return "Camera is too slow — add light or close other apps"
    if "motion" in v.reasons:
        return "Hold still"
    return fallback
