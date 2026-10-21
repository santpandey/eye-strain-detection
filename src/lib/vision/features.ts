import type { FrameFeatures } from './types';
import { emptyFeatures } from './types';

// Right eye then left eye, EAR ordering p1..p6.
const EAR_R = [33, 160, 158, 133, 153, 144];
const EAR_L = [362, 385, 387, 263, 373, 380];
const IRIS_R_CENTER = 468;
const IRIS_L_CENTER = 473;
const IRIS_R_RING: [number, number, number, number] = [469, 470, 471, 472];
const IRIS_L_RING: [number, number, number, number] = [474, 475, 476, 477];
const EAR_POINTS = [...EAR_R, ...EAR_L];

// Full eye contours used for glare ROIs.
export const EYE_CONTOUR_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const EYE_CONTOUR_L = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];

export type NormBox = [number, number, number, number]; // x0,y0,x1,y1, clamped 0..1

type Point = { x: number; y: number; z?: number };

interface BlendshapeCategory {
  categoryName?: string;
  score: number;
}

export interface LandmarkerResultLike {
  faceLandmarks: Point[][];
  faceBlendshapes?: { categories: BlendshapeCategory[] }[];
  facialTransformationMatrixes?: { data: number[] }[];
}

function dist(a: Point, b: Point, w: number, h: number): number {
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.hypot(dx, dy);
}

function ear(lm: Point[], idx: number[], w: number, h: number): number {
  const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
  const num = dist(p2, p6, w, h) + dist(p3, p5, w, h);
  const den = 2 * dist(p1, p4, w, h);
  return den > 0 ? num / den : 0;
}

function blend(cats: BlendshapeCategory[] | undefined, name: string): number {
  if (!cats) return 0;
  const c = cats.find((c) => c.categoryName === name);
  return c ? c.score : 0;
}

/**
 * Decompose the rotation part of the column-major facial transformation matrix
 * as R = Ry(yaw) * Rx(pitch) * Rz(roll). Returns degrees.
 */
export function decomposeRotation(m: number[]): { yaw: number; pitch: number; roll: number } {
  const r13 = m[8]; // row1 col3
  const r21 = m[1]; // row2 col1
  const r22 = m[5]; // row2 col2
  const r23 = m[9]; // row2 col3
  const r33 = m[10]; // row3 col3
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
  const rad = (v: number) => (v * 180) / Math.PI;
  return {
    yaw: rad(Math.atan2(r13, r33)),
    pitch: rad(-Math.asin(clamp1(r23))),
    roll: rad(Math.atan2(r21, r22)),
  };
}

function irisDiameter(lm: Point[], ring: [number, number, number, number], w: number, h: number): number {
  return (dist(lm[ring[0]], lm[ring[2]], w, h) + dist(lm[ring[1]], lm[ring[3]], w, h)) / 2;
}

function bbox(lm: Point[], idxs: number[]): [number, number, number, number] {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const i of idxs) {
    const p = lm[i];
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Whole-face bounding box (all landmarks), normalized + clamped. */
export function faceBox(lm: Point[]): NormBox {
  const [x0, y0, x1, y1] = bbox(lm, lm.map((_, i) => i));
  return [clamp01(x0), clamp01(y0), clamp01(x1), clamp01(y1)];
}

/** Eye-contour box expanded by padX/padY fractions of its own size. */
export function eyeBox(lm: Point[], contourIdx: number[], padX: number, padY: number): NormBox {
  const [x0, y0, x1, y1] = bbox(lm, contourIdx);
  const pw = ((x1 - x0) * padX) / 2;
  const ph = ((y1 - y0) * padY) / 2;
  return [clamp01(x0 - pw), clamp01(y0 - ph), clamp01(x1 + pw), clamp01(y1 + ph)];
}

export interface RoiMetrics {
  faceLuma: number;
  glare: [number, number];
}

export function computeFrameFeatures(
  res: LandmarkerResultLike,
  t: number,
  frameW: number,
  frameH: number,
  frameLuma: number,
  roi: RoiMetrics = { faceLuma: 0, glare: [0, 0] },
): FrameFeatures {
  const lm = res.faceLandmarks?.[0];
  const w = frameW;
  const h = frameH;
  if (!lm || lm.length < 478) {
    return emptyFeatures(t, frameW, frameH, frameLuma);
  }

  const cats = res.faceBlendshapes?.[0]?.categories;
  const rot = res.facialTransformationMatrixes?.[0]?.data;
  const { yaw, pitch, roll } = rot ? decomposeRotation(rot) : { yaw: 0, pitch: 0, roll: 0 };

  const rc = lm[IRIS_R_CENTER];
  const lc = lm[IRIS_L_CENTER];
  const irisPx = (irisDiameter(lm, IRIS_R_RING, w, h) + irisDiameter(lm, IRIS_L_RING, w, h)) / 2;
  const interocularPx = dist(rc, lc, w, h);
  const eyeContour: number[] = [];
  for (const i of EAR_POINTS) {
    eyeContour.push(lm[i].x, lm[i].y);
  }

  return {
    t,
    face: true,
    earL: ear(lm, EAR_L, w, h),
    earR: ear(lm, EAR_R, w, h),
    blinkL: blend(cats, 'eyeBlinkLeft'),
    blinkR: blend(cats, 'eyeBlinkRight'),
    squintL: blend(cats, 'eyeSquintLeft'),
    squintR: blend(cats, 'eyeSquintRight'),
    jawOpen: blend(cats, 'jawOpen'),
    lookDown: (blend(cats, 'eyeLookDownLeft') + blend(cats, 'eyeLookDownRight')) / 2,
    yaw,
    pitch,
    roll,
    irisPx,
    interocularPx,
    eyeCenters: [
      [rc.x, rc.y],
      [lc.x, lc.y],
    ],
    eyeContour,
    nose: [lm[1].x, lm[1].y],
    frameLuma,
    faceLuma: roi.faceLuma,
    glare: roi.glare,
    frameW,
    frameH,
  };
}

/** Approximate camera distance in cm. f = 0.75 * frameW, iris diameter ~1.17 cm. */
export function estimateDistanceCm(irisPx: number, frameW: number): number {
  if (irisPx <= 0) return 0;
  return (0.75 * frameW * 1.17) / irisPx;
}
