<script lang="ts">
  import { monitor as mon } from '../session/monitorSession.svelte';
  import { clock } from '../session/fileSession.svelte';

  let videoEl = $state<HTMLVideoElement | null>(null);
  let videoW = $state(0);
  let videoH = $state(0);

  // Hand the video element to the monitor. The element exists only while a
  // window is arming/capturing (camera presence matches a visible preview —
  // and display:none would break requestVideoFrameCallback anyway).
  $effect(() => {
    const el = videoEl;
    if (!el) return;
    mon.attachVideo(el);
    return () => mon.detachVideo(el);
  });

  /** Current exercise step: each step gets an equal share of the duration. */
  const exStep = $derived.by(() => {
    const ex = mon.activeExercise;
    if (!ex) return '';
    const elapsed = ex.seconds - mon.exerciseMsLeft / 1000;
    const idx = Math.min(ex.steps.length - 1, Math.floor((elapsed / ex.seconds) * ex.steps.length));
    return ex.steps[idx] ?? '';
  });
  const exSecondsLeft = $derived(Math.ceil(mon.exerciseMsLeft / 1000));
</script>

{#if mon.phase !== 'idle'}
  <div class="mon" data-testid="monitor-widget" data-phase={mon.phase}>
    {#if mon.activeExercise}
      <div class="mon-card" data-testid="monitor-exercise">
        <div class="mon-card-head">
          <strong>{mon.activeExercise.title}</strong>
          <span class="ex-count" aria-label="Seconds left">{exSecondsLeft}s</span>
        </div>
        <p class="mon-line muted">{exStep}</p>
        <div class="mon-actions">
          <button class="mon-btn primary" onclick={() => mon.finishExercise()}>Done</button>
          <button class="mon-btn" onclick={() => mon.skipExercise()}>Skip</button>
        </div>
      </div>
    {/if}

    {#each mon.activeReminders as r (r.id)}
      <div class="mon-card" data-testid="monitor-reminder" data-kind={r.kind}>
        <strong>{r.title}</strong>
        <p class="mon-line muted">{r.body}</p>
        <div class="mon-actions">
          {#if r.exercise}
            <button class="mon-btn primary" onclick={() => mon.startExercise(r)}>
              Start exercise
            </button>
          {/if}
          <button class="mon-btn" onclick={() => mon.dismissReminder(r.id)}>Dismiss</button>
        </div>
      </div>
    {/each}

    {#if mon.phase === 'arming' || mon.phase === 'capturing'}
      <div class="mon-card mon-media-card">
        <div class="mon-media">
          <video
            bind:this={videoEl}
            class="mirrored"
            playsinline
            muted
            onloadedmetadata={() => {
              videoW = videoEl?.videoWidth || 0;
              videoH = videoEl?.videoHeight || 0;
            }}
            style="aspect-ratio: {videoW && videoH ? `${videoW} / ${videoH}` : '4 / 3'};{mon.roiCss ? ' ' + mon.roiCss : ''}"
          ></video>
          <button class="mon-x over" onclick={() => mon.stop()} aria-label="Stop monitor" title="Stop">
            ✕
          </button>
        </div>
        <div class="mon-line">
          {#if mon.phase === 'arming'}
            Starting camera…
          {:else}
            Checking — {clock(mon.windowMsLeft / 1000)} · eyes only
          {/if}
        </div>
      </div>
    {:else if mon.phase === 'error'}
      <div class="mon-card">
        <div class="mon-card-head">
          <strong>Monitor stopped</strong>
          <button class="mon-x" onclick={() => mon.dismissError()} aria-label="Dismiss">✕</button>
        </div>
        <p class="mon-line muted">{mon.errorMsg}</p>
      </div>
    {:else}
      <div class="mon-chip" data-testid="monitor-chip">
        <span class="mon-dot" aria-hidden="true"></span>
        <span class="mon-chip-text">Monitor on · next check {clock(mon.nextWindowInMs / 1000)}</span>
        <button class="mon-x" onclick={() => mon.stop()} aria-label="Stop monitor" title="Stop monitor">
          ✕
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .mon {
    position: fixed;
    left: 16px;
    bottom: 16px;
    width: 220px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .mon-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;
  }
  .mon-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .mon-line {
    font-size: 0.78rem;
    line-height: 1.35;
    margin: 0;
  }
  .ex-count {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    color: var(--primary);
  }
  .mon-actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .mon-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 6px 10px;
    min-height: 32px;
    border-radius: 8px;
    cursor: pointer;
    flex: 1;
  }
  .mon-btn.primary {
    background: var(--primary);
    color: var(--on-primary);
    border-color: var(--primary);
  }
  .mon-media-card {
    padding: 8px;
  }
  .mon-media {
    position: relative;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
  }
  .mon-media video {
    display: block;
    width: 100%;
    max-height: min(260px, 40vh);
    object-fit: cover;
  }
  .mirrored {
    transform: scaleX(-1);
  }
  .mon-x {
    appearance: none;
    border: none;
    background: var(--surface-2);
    color: var(--muted);
    width: 28px;
    height: 28px;
    min-height: 28px;
    border-radius: 8px;
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
    display: inline-grid;
    place-items: center;
    flex: none;
  }
  .mon-x.over {
    position: absolute;
    top: 6px;
    right: 6px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .mon-x.over:hover {
    background: rgb(0 0 0 / 0.75);
  }
  .mon-media-card .mon-line {
    padding: 2px 4px 0;
    color: var(--muted);
  }
  .mon-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: var(--shadow);
    padding: 8px 12px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .mon-chip-text {
    flex: 1;
    min-width: 0;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mon-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--good);
    flex: none;
  }
  /* Keep clear of the mobile bottom nav bar. */
  @media (max-width: 719px) {
    .mon {
      left: 10px;
      bottom: 76px;
      width: 190px;
    }
  }
</style>
