import { CFG } from './config';

export type Status = 'good' | 'watch' | 'high' | 'na';

export type Metric =
  | 'blinkRate'
  | 'incompleteRatio'
  | 'meanBlinkMs'
  | 'reopenFrac'
  | 'perclos'
  | 'maxIbiMs'
  | 'distanceCm'
  | 'luma';

export type MetricStatuses = Record<Metric, Status>;

interface Core {
  blinkRate: number;
  incompleteRatio: number;
  meanBlinkMs: number;
  meanReopenFrac: number;
  perclos: number;
  maxIbiMs: number;
  distanceCm: number;
  luma: number;
}

/**
 * Metrics that actually indicate tired/drowsy eyes vs. metrics that mostly
 * reflect the task context. Literature basis: reading/screen tasks suppress
 * blink rate within ~1 min regardless of fatigue (Tayson 2023; Argiles 2015
 * found incomplete-blink share, not rate, correlates with CVS symptoms), so a
 * low blink rate means "screen focus → dry-eye risk", not tiredness. PERCLOS,
 * blink duration and slow lid reopening are the validated drowsiness signals
 * (Wierwille 1994; Schleicher 2008).
 */
export const FATIGUE_METRICS: Metric[] = [
  'incompleteRatio',
  'meanBlinkMs',
  'reopenFrac',
  'perclos',
];
export const CONTEXT_METRICS: Metric[] = ['blinkRate', 'maxIbiMs', 'distanceCm', 'luma'];

/** Headline verdict: fatigue signals outrank task-context signals. */
export function overallVerdict(s: MetricStatuses): string {
  const fatigue = FATIGUE_METRICS.map((m) => s[m]).filter((x) => x !== 'na');
  const context = CONTEXT_METRICS.map((m) => s[m]).filter((x) => x !== 'na');
  if (fatigue.includes('high')) return 'Your eyes look tired';
  if (fatigue.includes('watch')) return 'A few things to watch';
  if (context.includes('high') || context.includes('watch')) {
    return 'Screen-focus strain signs';
  }
  return 'Looking good';
}

export function assess(
  c: Core,
  eventCount: number,
  distanceAvailable = true,
): { statuses: MetricStatuses; tips: string[] } {
  const statuses: MetricStatuses = {
    blinkRate:
      c.blinkRate < CFG.blinkRateHighLow || c.blinkRate > CFG.blinkRateHighHigh
        ? 'high'
        : c.blinkRate < CFG.blinkRateWatchLow || c.blinkRate > CFG.blinkRateWatchHigh
          ? 'watch'
          : 'good',
    incompleteRatio:
      eventCount < CFG.minEventsIncomplete
        ? 'na'
        : c.incompleteRatio > CFG.incompleteHigh
          ? 'high'
          : c.incompleteRatio > CFG.incompleteWatch
            ? 'watch'
            : 'good',
    meanBlinkMs:
      eventCount < CFG.minEventsMeanBlink
        ? 'na'
        : c.meanBlinkMs > CFG.meanBlinkHighMs
          ? 'high'
          : c.meanBlinkMs > CFG.meanBlinkWatchMs
            ? 'watch'
            : 'good',
    reopenFrac:
      eventCount < CFG.minEventsMeanBlink
        ? 'na'
        : c.meanReopenFrac > CFG.reopenFracHigh
          ? 'high'
          : c.meanReopenFrac > CFG.reopenFracWatch
            ? 'watch'
            : 'good',
    perclos: c.perclos > CFG.perclosHigh ? 'high' : c.perclos > CFG.perclosWatch ? 'watch' : 'good',
    maxIbiMs:
      c.maxIbiMs > CFG.ibiHighMs ? 'high' : c.maxIbiMs > CFG.ibiWatchMs ? 'watch' : 'good',
    distanceCm: !distanceAvailable
      ? 'na'
      : c.distanceCm > 0 && c.distanceCm < CFG.distanceHighCm
        ? 'high'
        : c.distanceCm > 0 && c.distanceCm < CFG.distanceWatchCm
          ? 'watch'
          : 'good',
    luma: c.luma > 0 && c.luma < CFG.lumaWatch ? 'watch' : 'good',
  };
  return { statuses, tips: tipsFor(statuses, c, eventCount) };
}

function tipsFor(s: MetricStatuses, c: Core, eventCount: number): string[] {
  const tips: string[] = [];
  if (s.blinkRate !== 'good') {
    tips.push(
      c.blinkRate < CFG.blinkRateWatchLow
        ? `Your blink rate was low (${c.blinkRate.toFixed(0)}/min). Screen focus suppresses blinking — try 10 slow, full blinks now.`
        : `Your blink rate was high (${c.blinkRate.toFixed(0)}/min). That can signal irritation or dryness — consider lubricating drops and a short break.`,
    );
  }
  if (s.incompleteRatio === 'na') {
    // silently skipped — not enough events
  } else if (s.incompleteRatio !== 'good') {
    tips.push(
      'Many of your blinks were partial. Close your eyes fully for a second — that spreads the tear film properly.',
    );
  }
  if (s.meanBlinkMs !== 'good' && s.meanBlinkMs !== 'na') {
    tips.push('Your blinks were slow and heavy — a classic sign of tired eyes. A short break would help.');
  }
  if (s.reopenFrac !== 'good' && s.reopenFrac !== 'na') {
    tips.push(
      'Your eyelids were slow to reopen after blinking — a drowsiness sign. A real break beats forcing blinks.',
    );
  }
  if (s.perclos !== 'good') {
    tips.push('Your eyes stayed closed or nearly closed for a notable share of the check. Time to rest them.');
  }
  if (s.maxIbiMs !== 'good') {
    tips.push(
      `You went ${Math.round(c.maxIbiMs / 1000)}s without blinking at one point. Remind yourself to blink during focused work.`,
    );
  }
  if (s.distanceCm !== 'good' && s.distanceCm !== 'na') {
    tips.push(
      `You sat about ${Math.round(c.distanceCm)} cm from the screen. Aim for roughly 50–70 cm.`,
    );
  }
  if (s.luma !== 'good') {
    tips.push('The room looked dim. More ambient light (not glare on the screen) is easier on your eyes.');
  }
  if (eventCount < CFG.minEventsMeanBlink) {
    tips.push('Very few blinks were detected — treat the detailed metrics with care.');
  }
  return tips;
}

export const DISCLAIMER = 'Wellness guidance, not a medical diagnosis.';
