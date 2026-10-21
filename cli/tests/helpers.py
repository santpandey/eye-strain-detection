"""Synthetic FrameFeatures @30fps — port of tests/helpers.ts."""

FPS = 30
DT = 1000 / FPS

_t = [0.0]


def reset_clock():
    _t[0] = 0.0


def frame(over: dict | None = None):
    """A quality, eyes-open frame. Overrides simulate blinks etc."""
    from eyefd.features import FrameFeatures

    _t[0] += DT
    kw = dict(
        t=_t[0],
        face=True,
        earL=0.3,
        earR=0.3,
        blinkL=0.0,
        blinkR=0.0,
        squintL=0.0,
        squintR=0.0,
        jawOpen=0.0,
        lookDown=0.0,
        yaw=0.0,
        pitch=0.0,
        roll=0.0,
        irisPx=12.0,
        interocularPx=150.0,
        eyeCenters=[[0.4, 0.4], [0.6, 0.4]],
        eyeContour=[],
        nose=[0.5, 0.5],
        frameLuma=120.0,
        faceLuma=120.0,
        glare=[0.0, 0.0],
        frameW=640,
        frameH=480,
    )
    if over:
        kw.update(over)
    return FrameFeatures(**kw)


def open(n, over=None):
    """n open frames."""
    return [frame(over) for _ in range(n)]


def closed(n, over=None):
    """n fully-closed frames (c ≈ 1)."""
    base = {"earL": 0.0, "earR": 0.0, "blinkL": 1.0, "blinkR": 1.0}
    if over:
        base.update(over)
    return open(n, base)


def half_closed(n):
    """n partially-closed frames (peak c ≈ 0.6 → incomplete)."""
    return open(n, {"earL": 0.15, "earR": 0.15, "blinkL": 0.4, "blinkR": 0.4})


def noise(n):
    """n noisy sub-threshold frames (c ≈ 0.15 → prominence ≈ 0.15)."""
    return open(n, {"earL": 0.27, "earR": 0.27, "blinkL": 0.13, "blinkR": 0.13})


def feed_all(det, seq):
    for f in seq:
        det.push(f)


def make_result(over: dict | None = None) -> dict:
    """Minimal valid QuickCheckResult — override per test."""
    r = {
        "schemaVersion": 2,
        "id": "test-id",
        "startedAt": "2026-01-01T10:00:00.000Z",
        "durationMs": 90_000,
        "qualityMs": 85_000,
        "qualityPct": 94,
        "blinkRate": 15,
        "blinkRateLow": 10,
        "blinkRateHigh": 22,
        "completeBlinks": 18,
        "incompleteBlinks": 2,
        "incompleteRatio": 0.1,
        "meanBlinkMs": 160,
        "meanReopenFrac": 0.6,
        "longClosures": 0,
        "perclos": 0.02,
        "maxIbiMs": 6000,
        "ibiOver10s": 0,
        "distanceCm": 55,
        "luma": 120,
        "squint": 0.1,
        "yawns": 0,
        "fpsMean": 29,
        "glarePct": 0,
        "backlitPct": 0,
        "gazeDownDiscards": 0,
        "asymmetricDiscards": 0,
        "confidence": "high",
        "confidenceReasons": [],
        "tips": [],
        "statuses": {
            "blinkRate": "good",
            "incompleteRatio": "good",
            "meanBlinkMs": "good",
            "reopenFrac": "good",
            "perclos": "good",
            "maxIbiMs": "good",
            "distanceCm": "good",
            "luma": "good",
        },
        "source": "camera",
    }
    if over:
        r.update(over)
    return r
