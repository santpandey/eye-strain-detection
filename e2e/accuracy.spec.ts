import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { matchBlinks } from '../src/lib/analysis/eval';
import type { BlinkEvent } from '../src/lib/analysis/blink';
import type { FrameFeatures } from '../src/lib/vision/types';
import type { QuickCheckResult } from '../src/lib/analysis/session';

const EVAL_DIR = process.env.EVAL_DIR;

interface LabelsFile {
  video: string;
  durationMs: number;
  blinks: { t: number }[];
  meta?: { glasses?: boolean; lighting?: string; notes?: string };
}

interface Trace {
  source: string;
  frames: FrameFeatures[];
  result: QuickCheckResult & { detectorEvents?: BlinkEvent[] };
}

test.skip(!EVAL_DIR, 'Set EVAL_DIR to a folder with *.mp4|webm|mov + *.labels.json');

test('accuracy harness', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const dir = EVAL_DIR!;
  const videos = readdirSync(dir)
    .filter((f) => /\.(mp4|webm|mov)$/i.test(f))
    .filter((f) => existsSync(join(dir, f.replace(/\.[^.]+$/, '.labels.json'))));

  const rows: any[] = [];
  for (const video of videos) {
    const stem = video.replace(/\.[^.]+$/, '');
    const labels = JSON.parse(readFileSync(join(dir, `${stem}.labels.json`), 'utf8')) as LabelsFile;

    await page.goto('/?dev=1#/check');
    const buf = readFileSync(join(dir, video));
    await page.locator('input[type="file"]').setInputFiles({
      name: video,
      mimeType: 'video/webm',
      buffer: buf,
    });
    // Wait for results or abstain.
    await expect(page.getByTestId('results').or(page.getByTestId('abstain'))).toBeVisible({
      timeout: 8 * 60_000,
    });
    const trace = await page.evaluate(() => (window as any).__blinkwellLastTrace as Trace | undefined);
    // Replay events recorded in the trace result via the detector events array
    // embedded in the trace frames? Events aren't in the trace — recompute by
    // re-feeding through the detector client-side is heavy; instead the app
    // stores detected events on the trace for eval.
    const events: BlinkEvent[] = (trace as any)?.events ?? [];
    const qualityMin = (trace?.result?.qualityMs ?? 0) / 60000;
    const m = matchBlinks(events, labels.blinks, qualityMin);
    rows.push({
      video,
      ...m,
      trueRate: qualityMin > 0 ? labels.blinks.length / qualityMin : 0,
      detRate: trace?.result?.blinkRate ?? 0,
      meanBlinkMs: trace?.result?.meanBlinkMs ?? 0,
      confidence: trace?.result?.confidence ?? 'n/a',
      glasses: labels.meta?.glasses ?? false,
      lighting: labels.meta?.lighting ?? 'unknown',
    });
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'eval-report.json'), JSON.stringify(rows, null, 2));

  const lines: string[] = [
    '# Accuracy eval report',
    '',
    `Generated: ${new Date().toISOString()} · ${rows.length} clips`,
    '',
    '| clip | tp | fp | fn | precision | recall | F1 | true/min | det/min | mean ms | conf | meta |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.video} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.precision.toFixed(2)} | ${r.recall.toFixed(2)} | ${r.f1.toFixed(2)} | ${r.trueRate.toFixed(1)} | ${r.detRate.toFixed(1)} | ${r.meanBlinkMs.toFixed(0)} | ${r.confidence} | ${r.glasses ? 'glasses' : 'no-glasses'}/${r.lighting} |`,
    ),
  ];
  for (const key of ['glasses', 'lighting']) {
    lines.push('', `## By ${key}`, '', '| group | clips | F1 mean |', '|---|---|---|');
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const k = String(r[key]);
      groups.set(k, [...(groups.get(k) ?? []), r.f1]);
    }
    for (const [k, fs] of groups) {
      lines.push(`| ${k} | ${fs.length} | ${(fs.reduce((a, b) => a + b, 0) / fs.length).toFixed(2)} |`);
    }
  }
  writeFileSync(join(dir, 'eval-report.md'), lines.join('\n'));
  console.log(`wrote ${join(dir, 'eval-report.md')} for ${rows.length} clips`);
});
