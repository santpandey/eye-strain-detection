<script lang="ts">
  import { onMount } from 'svelte';
  import { getBaseline, listSessions } from '../lib/storage/db';
  import type { QuickCheckResult } from '../lib/analysis/session';
  import {
    baselineMedian,
    baselineReady,
    deltaText,
    emptyBaseline,
    usualDeltaPct,
    type BaselineStats,
  } from '../lib/analysis/baseline';
  import { scoreTier } from '../lib/analysis/fatigueScore';
  import { CONTEXT_METRICS, DISCLAIMER, FATIGUE_METRICS } from '../lib/analysis/thresholds';

  let sessions = $state<QuickCheckResult[]>([]);
  let openId = $state<string | null>(null);
  let baseline = $state<BaselineStats>(emptyBaseline());

  onMount(async () => {
    try {
      sessions = await listSessions();
    } catch {
      sessions = [];
    }
    try {
      baseline = await getBaseline();
    } catch {
      baseline = emptyBaseline();
    }
  });

  // Fatigue signals (tired lids, incomplete blinks, closure time) outrank
  // task-context signals (blink rate, gaps) — same split as the results page.
  function worstStatus(r: QuickCheckResult): 'good' | 'watch' | 'high' {
    const pick = (ms: readonly string[]) =>
      ms.map((m) => r.statuses?.[m as keyof typeof r.statuses]).filter(Boolean);
    const fatigue = pick(FATIGUE_METRICS);
    if (fatigue.includes('high')) return 'high';
    if (fatigue.includes('watch')) return 'watch';
    const context = pick(CONTEXT_METRICS);
    if (context.includes('high')) return 'high';
    if (context.includes('watch')) return 'watch';
    return 'good';
  }

  // Sparkline: last ~20 scores, chronological left → right.
  const SPARK_W = 160;
  const SPARK_H = 32;
  const sparkScores = $derived(
    sessions
      .filter((s) => s.fatigueScore != null)
      .slice(0, 20)
      .reverse()
      .map((s) => s.fatigueScore as number),
  );
  const sparkPoints = $derived(
    sparkScores
      .map((sc, i) => {
        const x = sparkScores.length > 1 ? (i / (sparkScores.length - 1)) * SPARK_W : SPARK_W / 2;
        const y = SPARK_H - 3 - (sc / 100) * (SPARK_H - 6);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' '),
  );

  /** "blink rate −38% · blink length +12%" summary vs the current baseline. */
  function vsUsual(s: QuickCheckResult): string {
    if (!baselineReady(baseline)) return '';
    const parts: string[] = [];
    const push = (label: string, value: number, metric: Parameters<typeof baselineMedian>[1]) => {
      const d = usualDeltaPct(value, baselineMedian(baseline, metric));
      if (d !== null) parts.push(`${label} ${deltaText(d)}`);
    };
    push('blink rate', s.blinkRate, 'blinkRate');
    if (s.statuses?.meanBlinkMs !== 'na') push('blink length', s.meanBlinkMs, 'meanBlinkMs');
    push('eye closure', s.perclos, 'perclos');
    return parts.join(' · ');
  }
</script>

<section class="stack">
  <h1>History</h1>
  {#if sessions.length === 0}
    <div class="card center">
      <p class="muted">No checks yet. Your results will appear here after your first eye check.</p>
      <a class="btn btn-primary" href="#/check">Start eye check</a>
    </div>
  {:else}
    {#if sparkScores.length >= 2}
      <div class="card spark" data-testid="fatigue-trend">
        <svg
          viewBox="0 0 {SPARK_W} {SPARK_H}"
          width={SPARK_W}
          height={SPARK_H}
          role="img"
          aria-label="Fatigue score trend, oldest to newest"
        >
          <polyline points={sparkPoints} fill="none" />
        </svg>
        <div class="muted small">
          Fatigue score · last {sparkScores.length} checks · latest {sparkScores[sparkScores.length - 1]}/100
        </div>
      </div>
    {/if}
    {#each sessions as s (s.id)}
      {@const st = worstStatus(s)}
      {@const vs = vsUsual(s)}
      <button
        class="card session"
        class:open={openId === s.id}
        onclick={() => (openId = openId === s.id ? null : s.id)}
        aria-expanded={openId === s.id}
      >
        <div class="session-head">
          <span class="dot dot-{st}" aria-label={st}></span>
          <span class="when">
            {new Date(s.startedAt).toLocaleString()}
            {#if s.source === 'file'}<span class="filetag">video file</span>{/if}
            {#if s.source === 'monitor'}<span class="filetag">monitor</span>{/if}
          </span>
          {#if s.fatigueScore != null}
            <span class="chip chip-{scoreTier(s.fatigueScore)}">{s.fatigueScore}</span>
          {/if}
          <span class="rate"><strong>{s.blinkRate.toFixed(0)}</strong> blinks/min</span>
        </div>
        {#if openId === s.id}
          <div class="details">
            <div class="drow"><span>Duration</span><span>{(s.durationMs / 1000).toFixed(0)}s ({s.qualityPct.toFixed(0)}% quality)</span></div>
            <div class="drow"><span>Blinks</span><span>{s.completeBlinks} full · {s.incompleteBlinks} partial</span></div>
            <div class="drow"><span>Mean blink</span><span>{s.meanBlinkMs.toFixed(0)} ms</span></div>
            <div class="drow"><span>Eye closure</span><span>{(s.perclos * 100).toFixed(1)}%</span></div>
            <div class="drow"><span>Longest gap</span><span>{(s.maxIbiMs / 1000).toFixed(1)}s</span></div>
            <div class="drow"><span>Distance</span><span>{s.distanceCm ? `≈${Math.round(s.distanceCm)} cm` : '—'}</span></div>
            <div class="drow"><span>Yawns</span><span>{s.yawns}</span></div>
            {#if s.fatigueScore != null}
              <div class="drow"><span>Fatigue score</span><span>{s.fatigueScore}/100 — higher means more tired</span></div>
            {/if}
            {#if vs}<div class="drow"><span>vs your usual</span><span>{vs}</span></div>{/if}
            {#if s.selfReport}<div class="drow"><span>Felt tired</span><span>{s.selfReport}/5</span></div>{/if}
            {#if s.confidence}<div class="drow"><span>Confidence</span><span>{s.confidence}</span></div>{/if}
            {#if s.tips.length}
              <ul class="tips">{#each s.tips as tip}<li>{tip}</li>{/each}</ul>
              <p class="muted small">{DISCLAIMER}</p>
            {/if}
          </div>
        {/if}
      </button>
    {/each}
  {/if}
</section>

<style>
  .center {
    text-align: center;
  }
  .session {
    width: 100%;
    text-align: left;
    font: inherit;
    color: var(--text);
    cursor: pointer;
  }
  .session-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex: none;
  }
  .dot-good {
    background: var(--good);
  }
  .dot-watch {
    background: var(--watch);
  }
  .dot-high {
    background: var(--high);
  }
  .when {
    flex: 1;
  }
  .filetag {
    margin-left: 8px;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 1px 8px;
    border-radius: 999px;
  }
  .rate {
    color: var(--muted);
  }
  .details {
    margin-top: 14px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .drow {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 0.9rem;
  }
  .drow span:first-child {
    color: var(--muted);
  }
  .tips {
    margin: 8px 0;
    padding-left: 20px;
  }
  .small {
    font-size: 0.82rem;
  }
  .spark {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 16px;
  }
  .spark svg {
    flex: none;
    overflow: visible;
  }
  .spark polyline {
    stroke: var(--primary);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
</style>
