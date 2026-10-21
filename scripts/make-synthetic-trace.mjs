// Generates a synthetic FrameFeatures trace + labels for the regression
// harness: 20 s at 30 fps with 4 full blinks (~167 ms) at known times.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'traces');
mkdirSync(out, { recursive: true });

const FPS = 30;
const DT = 1000 / FPS;
const DURATION_S = 20;
const BLINKS_MS = [3000, 8000, 13000, 18000];
const BLINK_FRAMES = 5;

let t = 0;
function mkFrame(over = {}) {
  t += DT;
  return {
    t,
    face: true,
    earL: 0.3,
    earR: 0.3,
    blinkL: 0,
    blinkR: 0,
    squintL: 0,
    squintR: 0,
    jawOpen: 0,
    lookDown: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    irisPx: 12,
    interocularPx: 150,
    eyeCenters: [
      [0.4, 0.4],
      [0.6, 0.4],
    ],
    eyeContour: [],
    nose: [0.5, 0.5],
    frameLuma: 120,
    faceLuma: 120,
    glare: [0, 0],
    frameW: 640,
    frameH: 480,
    ...over,
  };
}

const frames = [];
let bi = 0;
for (let i = 0; i < DURATION_S * FPS; i++) {
  const inBlink = bi < BLINKS_MS.length && t >= BLINKS_MS[bi] && t < BLINKS_MS[bi] + BLINK_FRAMES * DT;
  frames.push(inBlink ? mkFrame({ earL: 0, earR: 0, blinkL: 1, blinkR: 1 }) : mkFrame());
  if (bi < BLINKS_MS.length && t >= BLINKS_MS[bi] + BLINK_FRAMES * DT) bi++;
}

const trace = { schema: 1, source: 'synthetic', startedAt: '2026-01-01T00:00:00.000Z', frames };
const labels = {
  schema: 1,
  video: 'synthetic',
  durationMs: DURATION_S * 1000,
  blinks: BLINKS_MS.map((bt) => ({ t: bt + Math.round((BLINK_FRAMES * DT) / 2) })),
  minF1: 0.99,
  meta: { glasses: false, lighting: 'good', notes: 'generated fixture' },
};

writeFileSync(join(out, 'synthetic.trace.json'), JSON.stringify(trace));
writeFileSync(join(out, 'synthetic.labels.json'), JSON.stringify(labels, null, 2));
console.log('wrote', join(out, 'synthetic.trace.json'), 'and labels');
