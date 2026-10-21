/**
 * Offline blink-detector evaluation over recorded per-frame traces (no browser).
 *
 *   npm run eval:trace -- <trace.json>... <labels.json> [--tol 300] [--grid] [--cv]
 *   npm run eval:trace -- --set <labels.json> <trace.json>... [--set ...] [--grid] [--cv]
 *
 * `--set` groups traces with their own clip's labels (repeatable). The legacy
 * positional form is one implicit set. Frames are replayed through QualityCtx
 * + BlinkDetector — the same path as QuickCheckAggregator — and scored with
 * matchBlinks.
 *
 * Default mode: per-trace metrics + tables, then per-clip and pooled totals.
 * --grid: per-clip mean F1 + pooled F1 per config; valid = pooled precision
 *   ≥ 0.85.
 * --cv: leave-one-clip-out — grid on the other clips, plateau-centre pick,
 *   then score the held-out clip; prints chosen params and held-out metrics.
 *
 * Runs via Vite's module runner (see package.json "eval:trace"); args arrive
 * in globalThis.__evalArgs.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  BlinkDetector,
  defaultBlinkParams,
  type BlinkParams,
  type BlinkTraceSample,
} from '../src/lib/analysis/blink';
import { QualityCtx } from '../src/lib/analysis/quality';
import { matchBlinks, type MatchResult } from '../src/lib/analysis/eval';
import { CFG } from '../src/lib/analysis/config';
import type { BlinkEvent } from '../src/lib/analysis/blink';
import type { FrameFeatures } from '../src/lib/vision/types';

const argv: string[] =
  (globalThis as { __evalArgs?: string[] }).__evalArgs ?? process.argv.slice(2);

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error(
    'usage: eval-trace <trace.json>... <labels.json> | --set <labels.json> <trace.json>... [--set ...] [--tol 300] [--grid] [--cv]',
  );
  process.exit(2);
  throw new Error('unreachable');
}

interface TraceFile {
  name: string;
  frames: FrameFeatures[];
}
interface Clip {
  name: string;
  labels: number[];
  traces: TraceFile[];
}
/** set name → raw paths, in argv order. */
interface SetSpec {
  labels: string;
  traces: string[];
}

let tol: number = CFG.evalTraceTolMs;
let grid = false;
let cv = false;
const setSpecs: SetSpec[] = [];
let positional: { labels: string | null; traces: string[] } = { labels: null, traces: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tol') {
    tol = Number(argv[++i]);
  } else if (a === '--grid') {
    grid = true;
  } else if (a === '--cv') {
    cv = true;
  } else if (a === '--set') {
    const spec: SetSpec = { labels: '', traces: [] };
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      const p = argv[++i];
      if (p.endsWith('.labels.json')) {
        if (spec.labels) usage(`--set takes exactly one labels file (got ${p})`);
        spec.labels = p;
      } else spec.traces.push(p);
    }
    if (!spec.labels || spec.traces.length === 0) usage('--set needs a labels file and ≥1 trace');
    setSpecs.push(spec);
  } else if (a.startsWith('--')) {
    usage(`unknown option ${a}`);
  } else if (a.endsWith('.labels.json')) {
    if (positional.labels) usage(`multiple labels files: ${positional.labels}, ${a}`);
    positional.labels = a;
  } else {
    positional.traces.push(a);
  }
}
if (positional.labels && positional.traces.length) setSpecs.push(positional as SetSpec);
if (setSpecs.length === 0 || !Number.isFinite(tol)) usage();

function loadFrames(p: string): FrameFeatures[] {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const frames = j.trace?.frames ?? j.frames;
  if (!Array.isArray(frames)) throw new Error(`${p}: no frames / trace.frames array`);
  return frames;
}
const loadLabels = (p: string): number[] =>
  JSON.parse(readFileSync(p, 'utf8')).blinks.map((b: { t: number }) => b.t);

const clips: Clip[] = setSpecs.map((s) => ({
  name: basename(s.labels).replace(/\.labels\.json$/, ''),
  labels: loadLabels(s.labels),
  traces: s.traces.map((p) => ({ name: basename(p), frames: loadFrames(p) })),
}));

interface Run {
  det: BlinkDetector;
  m: MatchResult<BlinkEvent>;
  samples: BlinkTraceSample[];
}

function run(
  frames: FrameFeatures[],
  labels: number[],
  params: Partial<BlinkParams>,
  record = false,
): Run {
  const q = new QualityCtx();
  const det = new BlinkDetector(params);
  const samples: BlinkTraceSample[] = [];
  if (record) det.trace = samples;
  for (const f of frames) if (q.check(f).ok) det.push(f);
  det.finish();
  const m = matchBlinks(det.events, labels, det.qualityMs / 60000, tol);
  return { det, m, samples };
}

/** Pooled P/R/F1 from summed TP/FP/FN. */
function pool(ms: MatchResult<BlinkEvent>[]): { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number } {
  const tp = ms.reduce((a, m) => a + m.tp, 0);
  const fp = ms.reduce((a, m) => a + m.fp, 0);
  const fn = ms.reduce((a, m) => a + m.fn, 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

const f3 = (x: number) => x.toFixed(3);
const f2 = (x: number) => x.toFixed(2);
const ms = (x: number) => String(Math.round(x)).padStart(6);
const metricLine = (m: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number }) =>
  `TP ${m.tp}  FP ${m.fp}  FN ${m.fn}  P ${f3(m.precision)}  R ${f3(m.recall)}  F1 ${f3(m.f1)}`;

// ---------------------------------------------------------------- default --
if (!grid && !cv) {
  const params = defaultBlinkParams();
  console.log(`params ${JSON.stringify(params)}  tol ${tol} ms`);
  const allMs: MatchResult<BlinkEvent>[] = [];
  for (const clip of clips) {
    const clipMs: MatchResult<BlinkEvent>[] = [];
    for (const { name, frames } of clip.traces) {
      const { det, m, samples } = run(frames, clip.labels, params, true);
      clipMs.push(m);
      allMs.push(m);
      console.log(`\n=== ${name}  (${det.events.length} events, quality ${f2(det.qualityMs / 1000)} s, discards g${det.gazeDownDiscards}/a${det.asymmetricDiscards})`);
      console.log(metricLine(m));
      const long = det.events.filter((e) => e.longClosure);
      if (long.length)
        console.log(`long closures: ${long.map((e) => `${ms(e.start)}–${Math.round(e.end)}`).join(', ')}`);
      console.log('\n label |  start    end   peak  rest  kind');
      for (const { t, event: e } of m.labelMatches) {
        if (e) {
          const kind = e.complete ? (e.longClosure ? 'complete LONG' : 'complete') : 'incomplete';
          console.log(`${ms(t)} | ${ms(e.start)} ${ms(e.end)}  ${f2(e.peak)}  ${f2(e.rest)}  ${kind}`);
        } else {
          const near = samples.filter((s) => Math.abs(s.t - t) <= 600);
          if (!near.length) console.log(`${ms(t)} | MISS  (no quality frames within ±600 ms)`);
          else {
            const maxC = Math.max(...near.map((s) => s.c));
            const maxP = Math.max(...near.map((s) => s.c - s.rest));
            console.log(`${ms(t)} | MISS  max c ${f2(maxC)}  max prom ${f2(maxP)}  (±600 ms)`);
          }
        }
      }
      if (m.unmatchedEvents.length) {
        console.log('\nunmatched events (FP):');
        for (const e of m.unmatchedEvents) {
          console.log(
            `  ${ms(e.start)}–${ms(e.end)}  peak ${f2(e.peak)}  rest ${f2(e.rest)}  ${e.complete ? 'complete' : 'incomplete'}`,
          );
        }
      }
    }
    console.log(`\nclip ${clip.name} pooled (${clip.traces.length} traces, ${clip.labels.length} labels): ${metricLine(pool(clipMs))}`);
  }
  if (clips.length > 1) console.log(`\n=== POOLED all clips: ${metricLine(pool(allMs))}`);
  process.exit(0);
}

// ------------------------------------------------------------------- grid --
type GridKey =
  | 'promStart'
  | 'promEnd'
  | 'valleyDrop'
  | 'riseAgain'
  | 'restWindowMs'
  | 'restPercentile'
  | 'gazeDownRise';
const axes: Record<GridKey, number[]> = {
  promStart: [0.15, 0.2, 0.25, 0.3],
  promEnd: [0.08, 0.1, 0.15],
  valleyDrop: [0.2, 0.25, 0.3],
  riseAgain: [0.15, 0.2, 0.25],
  restWindowMs: [1500, 2000, 3000],
  restPercentile: [30],
  gazeDownRise: [0.15, 0.2, 0.3],
};
const keys = Object.keys(axes) as GridKey[];

interface Row {
  params: BlinkParams;
  idx: number[];
  clipF1s: number[]; // pooled F1 per clip
  pooled: ReturnType<typeof pool>;
  meanF1: number; // mean over clips
  ok: boolean;
}

const combos: number[][] = [[]];
for (const k of keys) {
  const next: number[][] = [];
  for (const c of combos) for (let i = 0; i < axes[k].length; i++) next.push([...c, i]);
  combos.splice(0, combos.length, ...next);
}

function runGrid(on: Clip[]): { rows: Row[]; valid: Row[]; picked: Row | null } {
  const rows: Row[] = [];
  for (const idx of combos) {
    const params: BlinkParams = { ...defaultBlinkParams() };
    keys.forEach((k, i) => (params[k] = axes[k][idx[i]]));
    const perTrace = on.map((clip) =>
      clip.traces.map(({ frames }) => run(frames, clip.labels, params).m),
    );
    const clipPooled = perTrace.map(pool);
    const pooled = pool(perTrace.flat());
    rows.push({
      params,
      idx,
      clipF1s: clipPooled.map((p) => p.f1),
      pooled,
      meanF1: clipPooled.reduce((a, p) => a + p.f1, 0) / on.length,
      ok: pooled.precision >= 0.85,
    });
  }
  const valid = rows.filter((r) => r.ok).sort((a, b) => b.meanF1 - a.meanF1);
  let picked: Row | null = null;
  let plateauOf = valid;
  if (!valid.length) {
    // No config reaches pooled precision ≥ 0.85: fall back to the highest
    // pooled-precision tier so a pick still exists (marked by callers).
    const bestPrec = Math.max(...rows.map((r) => r.pooled.precision));
    plateauOf = rows
      .filter((r) => r.pooled.precision >= bestPrec - 1e-9)
      .sort((a, b) => b.meanF1 - a.meanF1);
  }
  if (plateauOf.length) {
    const best = plateauOf[0].meanF1;
    const plateau = plateauOf.filter((r) => r.meanF1 >= best - 0.02);
    const norm = (ki: number, i: number) =>
      axes[keys[ki]].length > 1 ? i / (axes[keys[ki]].length - 1) : 0;
    const centre = keys.map(
      (_, ki) => plateau.reduce((s, r) => s + norm(ki, r.idx[ki]), 0) / plateau.length,
    );
    const dist = (r: Row) => Math.hypot(...keys.map((_, ki) => norm(ki, r.idx[ki]) - centre[ki]));
    picked = [...plateau].sort((a, b) => dist(a) - dist(b) || b.meanF1 - a.meanF1)[0];
  }
  return { rows, valid, picked };
}

const short = (p: BlinkParams) =>
  `pS ${p.promStart} pE ${p.promEnd} vD ${p.valleyDrop} rA ${p.riseAgain} W ${p.restWindowMs} P ${p.restPercentile} gR ${p.gazeDownRise}`;
const rowLine = (r: Row) =>
  `${short(r.params).padEnd(80)} meanClipF1 ${f3(r.meanF1)}  pooled P ${f3(r.pooled.precision)} R ${f3(r.pooled.recall)} F1 ${f3(r.pooled.f1)}  clipF1 [${r.clipF1s.map(f3).join(' ')}]`;

if (grid) {
  const { rows, valid, picked } = runGrid(clips);
  console.log(
    `grid: ${rows.length} configs × clips [${clips.map((c) => `${c.name}(${c.traces.length}tr)`).join(', ')}], tol ${tol} ms`,
  );
  console.log(`configs with pooled precision ≥ 0.85: ${valid.length}`);
  if (!valid.length || !picked) {
    const byPrec = [...rows].sort(
      (a, b) => b.pooled.precision - a.pooled.precision || b.meanF1 - a.meanF1,
    );
    console.log('\ntop 5 by pooled precision (no config reached 0.85):');
    for (const r of byPrec.slice(0, 5)) console.log('  ' + rowLine(r));
    process.exit(1);
  }
  console.log('\ntop 10:');
  for (const r of valid.slice(0, 10)) console.log('  ' + rowLine(r));
  console.log(`\nplateau-centre pick: ${rowLine(picked)}`);
  const def = defaultBlinkParams();
  const cur = rows.find((r) => keys.every((k) => r.params[k] === def[k]));
  if (cur)
    console.log(`\ncurrent defaults: ${rowLine(cur)}${cur.ok ? '' : '  (fails pooled precision ≥ 0.85)'}`);
  process.exit(0);
}

// --------------------------------------------------------------------- cv --
// Leave-one-clip-out: tune on the other clips, evaluate on the held-out clip.
{
  const heldMs: MatchResult<BlinkEvent>[] = [];
  for (let i = 0; i < clips.length; i++) {
    const held = clips[i];
    const train = clips.filter((_, j) => j !== i);
    if (!train.length) {
      console.log(`fold ${held.name}: skipped (only one clip)`);
      continue;
    }
    const { valid, picked } = runGrid(train);
    if (!picked) {
      console.log(`fold ${held.name}: grid produced no configs on train clips`);
      continue;
    }
    console.log(
      `fold ${held.name}: picked ${short(picked.params)}  (train meanClipF1 ${f3(picked.meanF1)}${valid.length ? `, ${valid.length} valid` : ', no config met pooled P ≥ 0.85 — fallback pick'})`,
    );
    const ms_ = held.traces.map(({ name, frames }) => {
      const r = run(frames, held.labels, picked.params);
      heldMs.push(r.m);
      console.log(`  ${name}: ${metricLine(r.m)}`);
      return r.m;
    });
    console.log(`  held-out pooled: ${metricLine(pool(ms_))}`);
  }
  if (heldMs.length) console.log(`\n=== CV pooled held-out: ${metricLine(pool(heldMs))}`);
}
