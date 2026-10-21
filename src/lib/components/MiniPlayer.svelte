<script lang="ts">
  import { fileSession as fs, clock } from '../session/fileSession.svelte';

  let videoEl = $state<HTMLVideoElement | null>(null);
  let videoW = $state(0);
  let videoH = $state(0);

  // Hand the video element to the session manager. The element stays mounted
  // (and visible — display:none breaks requestVideoFrameCallback) for the
  // whole 'analyzing' phase, on every route.
  $effect(() => {
    const el = videoEl;
    if (!el) return;
    fs.attachVideo(el);
    return () => fs.detachVideo(el);
  });

  function expand() {
    location.hash = '#/check';
  }

  const doneLabel = $derived(
    fs.phase === 'done'
      ? 'Analysis complete'
      : fs.phase === 'abstain'
        ? "Couldn't score this video"
        : fs.phase === 'stale'
          ? 'Refresh needed'
          : 'Video problem',
  );
</script>

{#if fs.phase !== 'idle'}
  <div class="mini-player" data-testid="mini-player" data-phase={fs.phase}>
    {#if fs.phase === 'analyzing'}
      <div class="mp-media">
        <video
          bind:this={videoEl}
          playsinline
          muted
          onloadedmetadata={() => {
            videoW = videoEl?.videoWidth || 0;
            videoH = videoEl?.videoHeight || 0;
          }}
          style="aspect-ratio: {videoW && videoH ? `${videoW} / ${videoH}` : '16 / 10'};{fs.roiCss ? ' ' + fs.roiCss : ''}"
        ></video>
        <div class="mp-topbtns">
          <button class="mp-btn" onclick={expand} aria-label="Open the Check page" title="Open Check">
            ⤢
          </button>
          <button class="mp-btn" onclick={() => fs.reset()} aria-label="Cancel analysis" title="Cancel">
            ✕
          </button>
        </div>
      </div>
      <div class="mp-bar" role="progressbar" aria-valuenow={Math.round(fs.progress * 100)}>
        <div class="mp-bar-fill" style:width="{fs.progress * 100}%"></div>
      </div>
      <div class="mp-stats">
        <span data-testid="mp-pos">
          {clock(fs.mediaPos)}{#if fs.mediaDur > 0} / {clock(fs.mediaDur)}{/if}
        </span>
        <span>usable {Math.floor(fs.usableMs / 1000)}s</span>
        <span>{fs.blinks} {fs.blinks === 1 ? 'blink' : 'blinks'}</span>
      </div>
      {#if fs.paused}
        <div class="mp-line mp-paused" data-testid="mp-paused">Paused — {fs.pauseReason}</div>
      {/if}
      {#if fs.etaS > 0}
        <div class="mp-line muted">
          {fs.etaText}{#if fs.slowed} · {fs.rateLabel} speed{/if}
        </div>
      {/if}
    {:else}
      <div class="mp-done-row">
        <span class="mp-done-text">{doneLabel}</span>
        <button class="mp-link" onclick={expand}>
          {fs.phase === 'done' ? 'View results' : 'View'}
        </button>
        <button class="mp-btn" onclick={() => fs.reset()} aria-label="Dismiss">✕</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .mini-player {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 220px;
    z-index: 40;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mp-media {
    position: relative;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
  }
  .mp-media video {
    display: block;
    width: 100%;
    /* Portrait phone clips must not grow into a tall strip: cap the height
       and letterbox inside the box (object-fit keeps the source ratio). */
    max-height: min(260px, 40vh);
    object-fit: contain;
  }
  .mp-topbtns {
    position: absolute;
    top: 6px;
    right: 6px;
    left: 6px;
    display: flex;
    justify-content: space-between;
    pointer-events: none;
  }
  .mp-topbtns .mp-btn {
    pointer-events: auto;
  }
  .mp-btn {
    appearance: none;
    border: none;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
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
  .mp-btn:hover {
    background: rgb(0 0 0 / 0.75);
  }
  .mp-bar {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .mp-bar-fill {
    height: 100%;
    background: var(--primary);
    transition: width 200ms linear;
  }
  .mp-stats {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .mp-stats span:first-child {
    color: var(--text);
    font-weight: 600;
  }
  .mp-line {
    font-size: 0.78rem;
    line-height: 1.3;
  }
  .mp-paused {
    color: var(--watch);
    font-weight: 600;
  }
  .mp-done-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
  }
  .mp-done-text {
    font-size: 0.82rem;
    font-weight: 600;
    flex: 1;
    min-width: 0;
  }
  .mp-done-row .mp-btn {
    background: var(--surface-2);
    color: var(--muted);
  }
  .mp-link {
    appearance: none;
    border: none;
    background: var(--primary);
    color: var(--on-primary);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    padding: 6px 10px;
    min-height: 32px;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  /* Keep clear of the mobile bottom nav bar. */
  @media (max-width: 719px) {
    .mini-player {
      right: 10px;
      bottom: 76px;
      width: 180px;
    }
  }
</style>
