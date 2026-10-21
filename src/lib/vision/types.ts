export interface FrameFeatures {
  t: number;
  face: boolean;
  earL: number;
  earR: number;
  blinkL: number;
  blinkR: number;
  squintL: number;
  squintR: number;
  jawOpen: number;
  lookDown: number; // mean of eyeLookDownLeft/Right blendshapes
  yaw: number;
  pitch: number;
  roll: number;
  irisPx: number;
  interocularPx: number;
  eyeCenters: [[number, number], [number, number]];
  eyeContour: number[];
  nose: [number, number]; // normalized landmark 1
  frameLuma: number; // mean Rec.601 luma, whole frame
  faceLuma: number; // mean luma inside the face bbox
  glare: [number, number]; // fraction of pixels >245 luma, [right, left] eye ROI
  frameW: number;
  frameH: number;
}

export type WorkerInMessage =
  | {
      type: 'init';
      wasmBase: string;
      modelUrl: string;
      /** Persisted override from localStorage `blinkwell.delegate` (workers have no localStorage). */
      delegate?: 'GPU' | 'CPU';
      /**
       * WebGL renderer the override was recorded on. When set and different
       * from the current renderer the override is ignored. Absent for the
       * legacy plain-string value, which is always honoured.
       */
      delegateRenderer?: string | null;
    }
  | { type: 'frame'; bitmap: ImageBitmap; t: number };

/** Why the engine switched GPU -> CPU at runtime. */
export type SwitchReason = 'no-face' | 'faster';

/** Startup GPU-vs-CPU latency benchmark (median detectForVideo ms). */
export interface DelegateTiming {
  gpuMedianMs: number;
  cpuMedianMs: number;
  gpuSamples: number;
  cpuSamples: number;
  chose: 'GPU' | 'CPU';
}

export type WorkerOutMessage =
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; renderer: string | null; software: boolean }
  | {
      type: 'result';
      f: FrameFeatures;
      switchedDelegate?: 'CPU';
      switchReason?: SwitchReason;
      /** Present on the frame where the startup benchmark finished. */
      timing?: DelegateTiming;
    }
  | { type: 'error'; message: string };

export function emptyFeatures(t: number, frameW: number, frameH: number, luma: number): FrameFeatures {
  return {
    t,
    face: false,
    earL: 0,
    earR: 0,
    blinkL: 0,
    blinkR: 0,
    squintL: 0,
    squintR: 0,
    jawOpen: 0,
    lookDown: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    irisPx: 0,
    interocularPx: 0,
    eyeCenters: [
      [0, 0],
      [0, 0],
    ],
    eyeContour: [],
    nose: [0, 0],
    frameLuma: luma,
    faceLuma: 0,
    glare: [0, 0],
    frameW,
    frameH,
  };
}
