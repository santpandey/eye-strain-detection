//! Per-frame features extracted from the FaceLandmarker result.
//!
//! 1:1 port of src/lib/vision/types.ts (FrameFeatures, emptyFeatures) and
//! src/lib/vision/features.ts (ear, decomposeRotation, estimateDistanceCm,
//! faceBox, eyeBox, computeFrameFeatures). Field names match the trace JSON.

use serde::{Deserialize, Serialize};

// Right eye then left eye, EAR ordering p1..p6.
pub const EAR_R: [usize; 6] = [33, 160, 158, 133, 153, 144];
pub const EAR_L: [usize; 6] = [362, 385, 387, 263, 373, 380];
pub const IRIS_R_CENTER: usize = 468;
pub const IRIS_L_CENTER: usize = 473;
pub const IRIS_R_RING: [usize; 4] = [469, 470, 471, 472];
pub const IRIS_L_RING: [usize; 4] = [474, 475, 476, 477];
pub const EAR_POINTS: [usize; 12] = [33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380];

// Full eye contours used for glare ROIs.
pub const EYE_CONTOUR_R: [usize; 16] = [
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
pub const EYE_CONTOUR_L: [usize; 16] = [
    362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
];

/// x0,y0,x1,y1, clamped 0..1.
pub type NormBox = [f64; 4];

#[derive(Debug, Clone, Copy, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone)]
pub struct CategoryLike {
    pub category_name: Option<String>,
    pub score: f64,
}

/// Shape-agnostic stand-in for the FaceLandmarker result (JS or C API).
#[derive(Debug, Clone, Default)]
pub struct LandmarkerResultLike {
    pub face_landmarks: Vec<Vec<Point>>,
    pub face_blendshapes: Vec<Vec<CategoryLike>>,
    /// Column-major 4x4 matrices (MediaPipe's native layout).
    pub facial_transformation_matrixes: Vec<[f64; 16]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameFeatures {
    pub t: f64,
    pub face: bool,
    pub ear_l: f64,
    pub ear_r: f64,
    pub blink_l: f64,
    pub blink_r: f64,
    pub squint_l: f64,
    pub squint_r: f64,
    pub jaw_open: f64,
    pub look_down: f64, // mean of eyeLookDownLeft/Right blendshapes
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub iris_px: f64,
    pub interocular_px: f64,
    pub eye_centers: [[f64; 2]; 2],
    pub eye_contour: Vec<f64>,
    pub nose: [f64; 2],  // normalized landmark 1
    pub frame_luma: f64, // mean Rec.601 luma, whole frame
    pub face_luma: f64,  // mean luma inside the face bbox
    pub glare: [f64; 2], // fraction of pixels >245 luma, [right, left] eye ROI
    pub frame_w: f64,
    pub frame_h: f64,
}

impl FrameFeatures {
    /// TS `emptyFeatures(t, frameW, frameH, luma)` — a face-less frame.
    pub fn empty(t: f64, frame_w: f64, frame_h: f64, luma: f64) -> Self {
        FrameFeatures {
            t,
            face: false,
            ear_l: 0.0,
            ear_r: 0.0,
            blink_l: 0.0,
            blink_r: 0.0,
            squint_l: 0.0,
            squint_r: 0.0,
            jaw_open: 0.0,
            look_down: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            roll: 0.0,
            iris_px: 0.0,
            interocular_px: 0.0,
            eye_centers: [[0.0, 0.0], [0.0, 0.0]],
            eye_contour: Vec::new(),
            nose: [0.0, 0.0],
            frame_luma: luma,
            face_luma: 0.0,
            glare: [0.0, 0.0],
            frame_w,
            frame_h,
        }
    }
}

fn dist(a: Point, b: Point, w: f64, h: f64) -> f64 {
    let dx = (a.x - b.x) * w;
    let dy = (a.y - b.y) * h;
    dx.hypot(dy)
}

pub fn ear(lm: &[Point], idx: &[usize; 6], w: f64, h: f64) -> f64 {
    let (p1, p2, p3, p4, p5, p6) = (
        lm[idx[0]], lm[idx[1]], lm[idx[2]], lm[idx[3]], lm[idx[4]], lm[idx[5]],
    );
    let num = dist(p2, p6, w, h) + dist(p3, p5, w, h);
    let den = 2.0 * dist(p1, p4, w, h);
    if den > 0.0 {
        num / den
    } else {
        0.0
    }
}

fn blend(cats: Option<&Vec<CategoryLike>>, name: &str) -> f64 {
    let Some(cats) = cats else { return 0.0 };
    cats.iter()
        .find(|c| c.category_name.as_deref() == Some(name))
        .map(|c| c.score)
        .unwrap_or(0.0)
}

/// Decompose the rotation part of the column-major facial transformation
/// matrix as R = Ry(yaw) * Rx(pitch) * Rz(roll). Returns degrees.
pub fn decompose_rotation(m: &[f64; 16]) -> (f64, f64, f64) {
    let r13 = m[8]; // row1 col3
    let r21 = m[1]; // row2 col1
    let r22 = m[5]; // row2 col2
    let r23 = m[9]; // row2 col3
    let r33 = m[10]; // row3 col3
    let clamp1 = |v: f64| v.clamp(-1.0, 1.0);
    let rad = |v: f64| v.to_degrees();
    (
        rad(r13.atan2(r33)),      // yaw
        rad(-clamp1(r23).asin()), // pitch
        rad(r21.atan2(r22)),      // roll
    )
}

fn iris_diameter(lm: &[Point], ring: &[usize; 4], w: f64, h: f64) -> f64 {
    (dist(lm[ring[0]], lm[ring[2]], w, h) + dist(lm[ring[1]], lm[ring[3]], w, h)) / 2.0
}

fn bbox(lm: &[Point], idxs: &[usize]) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (1.0, 1.0, 0.0, 0.0);
    for &i in idxs {
        let p = lm[i];
        if p.x < x0 {
            x0 = p.x;
        }
        if p.y < y0 {
            y0 = p.y;
        }
        if p.x > x1 {
            x1 = p.x;
        }
        if p.y > y1 {
            y1 = p.y;
        }
    }
    [x0, y0, x1, y1]
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Whole-face bounding box (all landmarks), normalized + clamped.
pub fn face_box(lm: &[Point]) -> NormBox {
    let idxs: Vec<usize> = (0..lm.len()).collect();
    let [x0, y0, x1, y1] = bbox(lm, &idxs);
    [clamp01(x0), clamp01(y0), clamp01(x1), clamp01(y1)]
}

/// Eye-contour box expanded by padX/padY fractions of its own size.
pub fn eye_box(lm: &[Point], contour_idx: &[usize], pad_x: f64, pad_y: f64) -> NormBox {
    let [x0, y0, x1, y1] = bbox(lm, contour_idx);
    let pw = (x1 - x0) * pad_x / 2.0;
    let ph = (y1 - y0) * pad_y / 2.0;
    [
        clamp01(x0 - pw),
        clamp01(y0 - ph),
        clamp01(x1 + pw),
        clamp01(y1 + ph),
    ]
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RoiMetrics {
    pub face_luma: f64,
    pub glare: [f64; 2],
}

/// 1:1 port of computeFrameFeatures. Landmarks are normalized; distances are
/// multiplied by frame w/h exactly as the TS does.
pub fn compute_frame_features(
    res: &LandmarkerResultLike,
    t: f64,
    frame_w: f64,
    frame_h: f64,
    frame_luma: f64,
    roi: RoiMetrics,
) -> FrameFeatures {
    let w = frame_w;
    let h = frame_h;
    let Some(lm) = res.face_landmarks.first() else {
        return FrameFeatures::empty(t, frame_w, frame_h, frame_luma);
    };
    if lm.len() < 478 {
        return FrameFeatures::empty(t, frame_w, frame_h, frame_luma);
    }

    let cats = res.face_blendshapes.first();
    let (yaw, pitch, roll) = match res.facial_transformation_matrixes.first() {
        Some(m) => decompose_rotation(m),
        None => (0.0, 0.0, 0.0),
    };

    let rc = lm[IRIS_R_CENTER];
    let lc = lm[IRIS_L_CENTER];
    let iris_px =
        (iris_diameter(lm, &IRIS_R_RING, w, h) + iris_diameter(lm, &IRIS_L_RING, w, h)) / 2.0;
    let interocular_px = dist(rc, lc, w, h);
    let mut eye_contour: Vec<f64> = Vec::with_capacity(EAR_POINTS.len() * 2);
    for &i in EAR_POINTS.iter() {
        eye_contour.push(lm[i].x);
        eye_contour.push(lm[i].y);
    }

    FrameFeatures {
        t,
        face: true,
        ear_l: ear(lm, &EAR_L, w, h),
        ear_r: ear(lm, &EAR_R, w, h),
        blink_l: blend(cats, "eyeBlinkLeft"),
        blink_r: blend(cats, "eyeBlinkRight"),
        squint_l: blend(cats, "eyeSquintLeft"),
        squint_r: blend(cats, "eyeSquintRight"),
        jaw_open: blend(cats, "jawOpen"),
        look_down: (blend(cats, "eyeLookDownLeft") + blend(cats, "eyeLookDownRight")) / 2.0,
        yaw,
        pitch,
        roll,
        iris_px,
        interocular_px,
        eye_centers: [[rc.x, rc.y], [lc.x, lc.y]],
        eye_contour,
        nose: [lm[1].x, lm[1].y],
        frame_luma,
        face_luma: roi.face_luma,
        glare: roi.glare,
        frame_w,
        frame_h,
    }
}

/// Approximate camera distance in cm. f = 0.75 * frameW, iris diameter ~1.17 cm.
pub fn estimate_distance_cm(iris_px: f64, frame_w: f64) -> f64 {
    if iris_px <= 0.0 {
        return 0.0;
    }
    (0.75 * frame_w * 1.17) / iris_px
}
