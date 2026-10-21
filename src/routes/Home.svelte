<script lang="ts">
  import { onMount } from 'svelte';
  import { latestSession } from '../lib/storage/db';
  import type { QuickCheckResult } from '../lib/analysis/session';
  import { monitor as mon } from '../lib/session/monitorSession.svelte';
  import { clock } from '../lib/session/fileSession.svelte';
  import Icon from '../lib/components/Icon.svelte';

  let last = $state<QuickCheckResult | null>(null);

  onMount(async () => {
    try {
      last = await latestSession();
    } catch {
      last = null;
    }
  });

  const tips = [
    { title: '20-20-20', body: 'Every 20 minutes, look at something ~6 m away for 20 seconds.' },
    { title: 'Blink fully', body: 'Screens suppress blinking. Close your eyes completely, slowly, a few times each hour.' },
    { title: 'Keep distance', body: 'Sit about 50–70 cm from the screen with the top at or below eye level.' },
  ];

  function worstStatus(r: QuickCheckResult): 'good' | 'watch' | 'high' {
    const s = Object.values(r.statuses ?? {}).filter((x) => x !== 'na');
    if (s.includes('high')) return 'high';
    if (s.includes('watch')) return 'watch';
    return 'good';
  }

  const monitorStatus = $derived(
    mon.phase === 'waiting'
      ? `On · next check in ${clock(mon.nextWindowInMs / 1000)}`
      : mon.phase === 'arming' || mon.phase === 'capturing'
        ? 'Checking now — camera is on'
        : mon.phase === 'error'
          ? `Stopped — ${mon.errorMsg}`
          : 'Off',
  );
</script>

<section class="stack">
  <div class="hero card">
    <h1>How are your eyes feeling?</h1>
    <p class="muted">
      A 90-second on-device check of your blinking and eye fatigue. Video never leaves this browser.
    </p>
    <a class="btn btn-primary" href="#/check"><Icon name="check" size={18} /> Start eye check</a>
  </div>

  {#if last}
    <a class="card last-card" href="#/history">
      <div class="row" style="justify-content: space-between; width:100%">
        <div>
          <div class="muted small">Last check · {new Date(last.startedAt).toLocaleString()}</div>
          <div><strong>{last.blinkRate.toFixed(0)}</strong> blinks/min · {last.completeBlinks + last.incompleteBlinks} blinks</div>
        </div>
        <span class="chip chip-{worstStatus(last)}">{worstStatus(last)}</span>
      </div>
    </a>
  {/if}

  <div class="card monitor-card" data-testid="monitor-card">
    <div class="row" style="justify-content: space-between; width:100%">
      <h2 style="margin:0">Background monitor</h2>
      {#if mon.phase !== 'idle'}<span class="chip chip-good">on</span>{/if}
    </div>
    <p class="muted small">
      Every ~15 minutes the camera turns on for about a minute — showing only your eye
      region — to watch your blink pattern and nudge you toward breaks. The camera is
      fully off between checks; nothing is recorded or uploaded. Wellness guidance,
      not a medical diagnosis.
    </p>
    <div class="row">
      {#if mon.phase === 'idle' || mon.phase === 'error'}
        <button class="btn btn-primary" onclick={() => mon.start()} data-testid="monitor-start">
          Turn on monitoring
        </button>
      {:else}
        <button class="btn btn-secondary" onclick={() => mon.stop()} data-testid="monitor-stop">
          Turn off
        </button>
        <span class="muted small" data-testid="monitor-status">{monitorStatus}</span>
      {/if}
    </div>
  </div>

  <h2>Quick eye-care tips</h2>
  <div class="grid tips">
    {#each tips as tip}
      <div class="card">
        <strong>{tip.title}</strong>
        <p class="muted small">{tip.body}</p>
      </div>
    {/each}
  </div>
</section>

<style>
  .hero {
    padding: 32px 24px;
  }
  .hero .btn {
    margin-top: 8px;
  }
  .last-card {
    text-decoration: none;
    color: var(--text);
    display: block;
  }
  .small {
    font-size: 0.82rem;
  }
  .tips .card {
    padding: 16px;
  }
</style>
