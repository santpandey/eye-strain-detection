"""Frame capture: OpenCV camera/file → MediaPipe FaceLandmarker → FrameFeatures.

Mirrors the measurement side of src/lib/vision/engine.ts + client.ts: whole-frame
luma at 64×48, face-region luma at 32×32, eye-ROI glare at 48×24, then the same
compute_frame_features() math. Analysis downstream is the pure ported pipeline.

Model: FaceLandmarker VIDEO mode, CPU delegate (Windows-first; the app's own
fallback), blendshapes + transformation matrix on. All local — no network.
"""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np

from .config import CFG
from .features import (
    EYE_CONTOUR_L,
    EYE_CONTOUR_R,
    FrameFeatures,
    compute_frame_features,
    eye_box,
    face_box,
)

# engine.ts sampler sizes
_LUMA_W, _LUMA_H = 64, 48
_FACE_W, _FACE_H = 32, 32
_EYE_W, _EYE_H = 48, 24


def default_model_path() -> Path:
    """public/models/face_landmarker.task relative to the repo root."""
    return Path(__file__).resolve().parents[2] / "public" / "models" / "face_landmarker.task"


def _luma_stats(bgr: np.ndarray) -> tuple:
    """(mean Rec.601 luma, fraction of pixels > glareLumaCut) of a BGR image."""
    y = 0.299 * bgr[..., 2] + 0.587 * bgr[..., 1] + 0.114 * bgr[..., 0]
    return float(y.mean()), float((y > CFG.glareLumaCut).mean())


def _region_luma(bgr: np.ndarray, box, w: int, h: int) -> tuple:
    """Luma stats of a normalized box, resampled to w×h (canvas region sampler)."""
    fh, fw = bgr.shape[:2]
    x0, y0, x1, y1 = box
    sx = int(x0 * fw)
    sy = int(y0 * fh)
    sw = max(1, int((x1 - x0) * fw))
    sh = max(1, int((y1 - y0) * fh))
    crop = bgr[sy : sy + sh, sx : sx + sw]
    if crop.size == 0:
        return 0.0, 0.0
    return _luma_stats(cv2.resize(crop, (w, h), interpolation=cv2.INTER_AREA))


class LandmarkerEngine:
    """MediaPipe FaceLandmarker (VIDEO mode, CPU) producing FrameFeatures."""

    def __init__(self, model_path: Path | None = None) -> None:
        import mediapipe as mp  # heavy import — deferred

        model_path = model_path or default_model_path()
        if not model_path.exists():
            raise FileNotFoundError(f"model not found: {model_path}")
        options = mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(
                model_asset_path=str(model_path),
                delegate=mp.tasks.BaseOptions.Delegate.CPU,
            ),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_faces=1,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self._mp = mp
        self._landmarker = mp.tasks.vision.FaceLandmarker.create_from_options(options)
        self._last_ts = -1

    def close(self) -> None:
        self._landmarker.close()

    def process(self, bgr: np.ndarray, t_ms: float) -> FrameFeatures:
        """One BGR frame → FrameFeatures. t_ms = frame timestamp (ms, monotonic
        or media time)."""
        mp = self._mp
        h, w = bgr.shape[:2]
        frame_luma = _luma_stats(cv2.resize(bgr, (_LUMA_W, _LUMA_H), interpolation=cv2.INTER_AREA))[0]

        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        # detect_for_video needs strictly increasing timestamps; FrameFeatures.t
        # keeps the original t (mirrors engine.ts).
        ts = max(int(t_ms), self._last_ts + 1)
        self._last_ts = ts
        res = self._landmarker.detect_for_video(mp_image, ts)

        landmarks = res.face_landmarks or []
        blendshapes = res.face_blendshapes or []
        matrices = res.facial_transformation_matrixes or []

        res_like = {
            "faceLandmarks": [
                [{"x": p.x, "y": p.y, "z": p.z} for p in landmarks[0]]
            ]
            if landmarks
            else [],
            "faceBlendshapes": [
                {
                    "categories": [
                        {"categoryName": c.category_name, "score": c.score}
                        for c in blendshapes[0]
                    ]
                }
            ]
            if blendshapes
            else [],
            "facialTransformationMatrixes": [
                {"data": np.asarray(matrices[0], dtype=np.float64).flatten(order="F").tolist()}
            ]
            if matrices
            else [],
        }

        face_luma = 0.0
        glare = [0.0, 0.0]
        lm = res_like["faceLandmarks"][0] if res_like["faceLandmarks"] else None
        if lm is not None and len(lm) >= 478:
            face_luma = _region_luma(bgr, face_box(lm), _FACE_W, _FACE_H)[0]
            glare[0] = _region_luma(bgr, eye_box(lm, EYE_CONTOUR_R, 0.25, 0.6), _EYE_W, _EYE_H)[1]
            glare[1] = _region_luma(bgr, eye_box(lm, EYE_CONTOUR_L, 0.25, 0.6), _EYE_W, _EYE_H)[1]

        return compute_frame_features(res_like, t_ms, w, h, frame_luma, {
            "faceLuma": face_luma,
            "glare": glare,
        })


def open_camera(camera_index: int = 0):
    """cv2.VideoCapture — try CAP_DSHOW on Windows for faster open."""
    cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        cap.release()
        return None
    return cap


def iter_camera_features(
    engine: LandmarkerEngine,
    camera_index: int,
    duration_ms: float,
    on_frame=None,
):
    """Yield FrameFeatures from the camera for duration_ms of wall time.

    The caller owns VideoCapture lifetime — this generator opens it at first
    iteration and always releases it on exit (webcam LED off)."""
    cap = open_camera(camera_index)
    if cap is None:
        raise RuntimeError(f"could not open camera {camera_index}")
    try:
        t0 = time.perf_counter()
        n = 0
        while True:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            if elapsed_ms >= duration_ms:
                break
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            f = engine.process(frame, elapsed_ms)
            n += 1
            if on_frame is not None:
                on_frame(f, n, elapsed_ms)
            yield f
    finally:
        cap.release()


def iter_file_features(engine: LandmarkerEngine, path: str | Path, on_frame=None):
    """Yield FrameFeatures from a video FILE, t = media time in ms
    (POS_MSEC, falling back to index × 1000/fps when the backend reports
    nothing sane). Every frame is processed."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        cap.release()
        raise RuntimeError(f"could not open video file: {path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps <= 0 or fps != fps:
            fps = 30.0
        i = 0
        prev_t = -1.0
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC)
            if not t or t <= prev_t or t != t:
                t = i * 1000.0 / fps
            if t <= prev_t:  # VFR fallback ran backwards — keep t monotonic
                t = prev_t + 1000.0 / fps
            prev_t = t
            f = engine.process(frame, t)
            i += 1
            if on_frame is not None:
                on_frame(f, i, t)
            yield f
    finally:
        cap.release()
