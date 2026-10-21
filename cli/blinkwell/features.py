"""landmarks/blendshapes/matrix -> FrameFeatures.

Keep in sync with src/lib/vision/features.ts and src/lib/vision/types.ts —
this is a 1:1 port. Pixel-space distances (w, h = frame size).

`compute_frame_features` takes a MediaPipe-result-shaped dict (the TS
`LandmarkerResultLike` shape):

    {
      "faceLandmarks": [{"x": …, "y": …, "z": …}, …],
      "faceBlendshapes": [{"categories": [{"categoryName": …, "score": …}]}],
      "facialTransformationMatrixes": [{"data": [16 floats, column-major]}],
    }

`capture.py` builds that shape from the Python mediapipe result.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

# Right eye then left eye, EAR ordering p1..p6.
EAR_R = [33, 160, 158, 133, 153, 144]
EAR_L = [362, 385, 387, 263, 373, 380]
IRIS_R_CENTER = 468
IRIS_L_CENTER = 473
IRIS_R_RING = [469, 470, 471, 472]
IRIS_L_RING = [474, 475, 476, 477]
EAR_POINTS = EAR_R + EAR_L

# Full eye contours used for glare ROIs.
EYE_CONTOUR_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
EYE_CONTOUR_L = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

# NormBox = (x0, y0, x1, y1), clamped 0..1

_FEATURE_FIELDS = (
    "t", "face", "earL", "earR", "blinkL", "blinkR", "squintL", "squintR",
    "jawOpen", "lookDown", "yaw", "pitch", "roll", "irisPx", "interocularPx",
    "eyeCenters", "eyeContour", "nose", "frameLuma", "faceLuma", "glare",
    "frameW", "frameH",
)


@dataclass
class FrameFeatures:
    """Same field names as the TS FrameFeatures interface."""

    t: float
    face: bool
    earL: float
    earR: float
    blinkL: float
    blinkR: float
    squintL: float
    squintR: float
    jawOpen: float
    lookDown: float  # mean of eyeLookDownLeft/Right blendshapes
    yaw: float
    pitch: float
    roll: float
    irisPx: float
    interocularPx: float
    eyeCenters: list  # [[x, y], [x, y]]
    eyeContour: list  # flat [x, y, …]
    nose: list  # [x, y] normalized landmark 1
    frameLuma: float  # mean Rec.601 luma, whole frame
    faceLuma: float  # mean luma inside the face bbox
    glare: list  # fraction of pixels >245 luma, [right, left] eye ROI
    frameW: float
    frameH: float

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "FrameFeatures":
        kw = {k: d[k] for k in _FEATURE_FIELDS if k in d}
        return FrameFeatures(**kw)


def empty_features(t: float, frame_w: float, frame_h: float, luma: float) -> FrameFeatures:
    return FrameFeatures(
        t=t,
        face=False,
        earL=0.0,
        earR=0.0,
        blinkL=0.0,
        blinkR=0.0,
        squintL=0.0,
        squintR=0.0,
        jawOpen=0.0,
        lookDown=0.0,
        yaw=0.0,
        pitch=0.0,
        roll=0.0,
        irisPx=0.0,
        interocularPx=0.0,
        eyeCenters=[[0.0, 0.0], [0.0, 0.0]],
        eyeContour=[],
        nose=[0.0, 0.0],
        frameLuma=luma,
        faceLuma=0.0,
        glare=[0.0, 0.0],
        frameW=frame_w,
        frameH=frame_h,
    )


def _dist(a: dict, b: dict, w: float, h: float) -> float:
    dx = (a["x"] - b["x"]) * w
    dy = (a["y"] - b["y"]) * h
    return math.hypot(dx, dy)


def ear(lm: list, idx: list, w: float, h: float) -> float:
    p1, p2, p3, p4, p5, p6 = (lm[i] for i in idx)
    num = _dist(p2, p6, w, h) + _dist(p3, p5, w, h)
    den = 2 * _dist(p1, p4, w, h)
    return num / den if den > 0 else 0.0


def _blend(cats, name: str) -> float:
    if not cats:
        return 0.0
    for c in cats:
        if c.get("categoryName") == name:
            return c.get("score", 0.0)
    return 0.0


def decompose_rotation(m: list) -> dict:
    """Decompose the rotation part of the column-major facial transformation
    matrix as R = Ry(yaw) * Rx(pitch) * Rz(roll). Returns degrees."""
    r13 = m[8]  # row1 col3
    r21 = m[1]  # row2 col1
    r22 = m[5]  # row2 col2
    r23 = m[9]  # row2 col3
    r33 = m[10]  # row3 col3
    clamp1 = lambda v: max(-1.0, min(1.0, v))
    rad = lambda v: (v * 180.0) / math.pi
    return {
        "yaw": rad(math.atan2(r13, r33)),
        "pitch": rad(-math.asin(clamp1(r23))),
        "roll": rad(math.atan2(r21, r22)),
    }


def _iris_diameter(lm: list, ring: list, w: float, h: float) -> float:
    return (_dist(lm[ring[0]], lm[ring[2]], w, h) + _dist(lm[ring[1]], lm[ring[3]], w, h)) / 2


def _bbox(lm: list, idxs) -> tuple:
    x0, y0, x1, y1 = 1.0, 1.0, 0.0, 0.0
    for i in idxs:
        p = lm[i]
        if p["x"] < x0:
            x0 = p["x"]
        if p["y"] < y0:
            y0 = p["y"]
        if p["x"] > x1:
            x1 = p["x"]
        if p["y"] > y1:
            y1 = p["y"]
    return (x0, y0, x1, y1)


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def face_box(lm: list) -> tuple:
    """Whole-face bounding box (all landmarks), normalized + clamped."""
    x0, y0, x1, y1 = _bbox(lm, range(len(lm)))
    return (_clamp01(x0), _clamp01(y0), _clamp01(x1), _clamp01(y1))


def eye_box(lm: list, contour_idx: list, pad_x: float, pad_y: float) -> tuple:
    """Eye-contour box expanded by padX/padY fractions of its own size."""
    x0, y0, x1, y1 = _bbox(lm, contour_idx)
    pw = ((x1 - x0) * pad_x) / 2
    ph = ((y1 - y0) * pad_y) / 2
    return (_clamp01(x0 - pw), _clamp01(y0 - ph), _clamp01(x1 + pw), _clamp01(y1 + ph))


def compute_frame_features(
    res: dict,
    t: float,
    frame_w: float,
    frame_h: float,
    frame_luma: float,
    roi: dict | None = None,
) -> FrameFeatures:
    if roi is None:
        roi = {"faceLuma": 0.0, "glare": [0.0, 0.0]}
    landmarks = res.get("faceLandmarks") or []
    lm = landmarks[0] if landmarks else None
    w = frame_w
    h = frame_h
    if not lm or len(lm) < 478:
        return empty_features(t, frame_w, frame_h, frame_luma)

    bshapes = res.get("faceBlendshapes") or []
    cats = (bshapes[0] or {}).get("categories") if bshapes else None
    mats = res.get("facialTransformationMatrixes") or []
    rot = (mats[0] or {}).get("data") if mats else None
    yaw, pitch, roll = (0.0, 0.0, 0.0)
    if rot:
        r = decompose_rotation(rot)
        yaw, pitch, roll = r["yaw"], r["pitch"], r["roll"]

    rc = lm[IRIS_R_CENTER]
    lc = lm[IRIS_L_CENTER]
    iris_px = (_iris_diameter(lm, IRIS_R_RING, w, h) + _iris_diameter(lm, IRIS_L_RING, w, h)) / 2
    interocular_px = _dist(rc, lc, w, h)
    eye_contour: list = []
    for i in EAR_POINTS:
        eye_contour.append(lm[i]["x"])
        eye_contour.append(lm[i]["y"])

    return FrameFeatures(
        t=t,
        face=True,
        earL=ear(lm, EAR_L, w, h),
        earR=ear(lm, EAR_R, w, h),
        blinkL=_blend(cats, "eyeBlinkLeft"),
        blinkR=_blend(cats, "eyeBlinkRight"),
        squintL=_blend(cats, "eyeSquintLeft"),
        squintR=_blend(cats, "eyeSquintRight"),
        jawOpen=_blend(cats, "jawOpen"),
        lookDown=(_blend(cats, "eyeLookDownLeft") + _blend(cats, "eyeLookDownRight")) / 2,
        yaw=yaw,
        pitch=pitch,
        roll=roll,
        irisPx=iris_px,
        interocularPx=interocular_px,
        eyeCenters=[[rc["x"], rc["y"]], [lc["x"], lc["y"]]],
        eyeContour=eye_contour,
        nose=[lm[1]["x"], lm[1]["y"]],
        frameLuma=frame_luma,
        faceLuma=roi["faceLuma"],
        glare=list(roi["glare"]),
        frameW=frame_w,
        frameH=frame_h,
    )


def estimate_distance_cm(iris_px: float, frame_w: float) -> float:
    """Approximate camera distance in cm. f = 0.75 * frameW, iris diameter ~1.17 cm."""
    if iris_px <= 0:
        return 0.0
    return (0.75 * frame_w * 1.17) / iris_px
