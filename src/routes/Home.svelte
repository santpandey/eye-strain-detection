<script lang="ts">
  import { onMount } from 'svelte';
  import { latestSession } from '../lib/storage/db';
  import type { QuickCheckResult } from '../lib/analysis/session';
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
