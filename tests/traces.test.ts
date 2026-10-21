import { describe, expect, it } from 'vitest';
import { QuickCheckAggregator } from '../src/lib/analysis/session';
import { matchBlinks } from '../src/lib/analysis/eval';
import { CFG } from '../src/lib/analysis/config';
import type { FrameFeatures } from '../src/lib/vision/types';

interface LabelsFile {
  video: string;
  durationMs: number;
  blinks: { t: number }[];
  minF1?: number;
}

const traces = import.meta.glob<{ frames: FrameFeatures[] }>('./traces/*.trace.json', {
  eager: true,
  import: 'default',
});
const labels = import.meta.glob<LabelsFile>('./traces/*.labels.json', {
  eager: true,
  import: 'default',
});

const pairs = Object.keys(traces)
  .map((p) => [p, p.replace('.trace.json', '.labels.json')] as const)
  .filter(([, lp]) => lp in labels);

describe('trace regression', () => {
  it.each(pairs.length ? pairs : [['__none__', ''] as const])('%s', (tp, lp) => {
    if (tp === '__none__') return; // no fixtures — nothing to check
    const agg = new QuickCheckAggregator();
    for (const f of traces[tp].frames) agg.push(f);
    const result = agg.result('file');
    const lab = labels[lp];

    const m = matchBlinks(agg.detector.events, lab.blinks, agg.detector.qualityMs / 60000);
    expect(m.f1, `F1 ${m.f1} for ${tp} (blinkRate ${result.blinkRate})`).toBeGreaterThanOrEqual(
      lab.minF1 ?? CFG.defaultMinF1,
    );
  });
});
