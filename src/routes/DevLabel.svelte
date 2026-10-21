<script lang="ts">
  import { onMount } from 'svelte';
  import { isDev } from '../lib/dev';

  interface Mark {
    t: number;
  }

  let videoEl = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let fileName = $state('');
  let objectUrl = '';
  let durationMs = $state(0);
  let playing = $state(false);
  let marks = $state<Mark[]>([]);
  let glasses = $state(false);
  let lighting = $state<'good' | 'dim' | 'backlit'>('good');
  let notes = $state('');

  const dev = isDev();

  function pick() {
    fileInput?.click();
  }

  function onFile(ev: Event) {
    const f = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!f || !videoEl) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(f);
    fileName = f.name;
    marks = [];
    videoEl.src = objectUrl;
    videoEl.load();
  }

  function step(frames: number) {
    if (!videoEl) return;
    videoEl.pause();
    playing = false;
    videoEl.currentTime = Math.max(
      0,
      Math.min(videoEl.duration || 0, videoEl.currentTime + frames / 30),
    );
  }

  function markBlink() {
    if (!videoEl) return;
    marks = [...marks, { t: Math.round(videoEl.currentTime * 1000) }];
  }

  function undo() {
    marks = marks.slice(0, -1);
  }

  function toggle() {
    if (!videoEl) return;
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  }

  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    // A focused button would also fire its own click on Space/Enter; drop focus
    // so the shortcut is the only action.
    if (tag === 'BUTTON') (e.target as HTMLElement).blur();
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'b' || e.key === 'B') markBlink();
    else if (e.key === 'Backspace') {
      e.preventDefault();
      undo();
    }
  }

  function download() {
    const payload = {
      schema: 1,
      video: fileName,
      durationMs: Math.round(durationMs),
      blinks: marks.map((m) => ({ t: m.t })),
      meta: { glasses, lighting, notes },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.[^.]+$/, '') + '.labels.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function fmt(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  onMount(() => {
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

<input bind:this={fileInput} type="file" accept="video/*" class="hidden" onchange={onFile} />

{#if !dev}
  <section class="card"><p class="muted">Enable Developer tools in Settings to use the labeler.</p></section>
{:else}
  <section class="stack">
    <div class="row" style="justify-content: space-between">
      <h1>Label blinks</h1>
      <button class="btn btn-secondary" onclick={pick}>Load video…</button>
    </div>

    <div class="video-wrap card">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        muted
        playsinline
        onloadedmetadata={() => (durationMs = (videoEl?.duration || 0) * 1000)}
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
        onended={() => (playing = false)}
      ></video>
      {#if !fileName}<div class="empty muted">Load a video file to start labeling.</div>{/if}
    </div>

    <div class="row">
      <button class="btn btn-secondary" onclick={() => step(-1)}>◀ 1 frame</button>
      <button class="btn btn-secondary" onclick={toggle}>{playing ? 'Pause' : 'Play'}</button>
      <button class="btn btn-secondary" onclick={() => step(1)}>1 frame ▶</button>
      <button class="btn btn-primary" onclick={markBlink} disabled={!fileName}>B — mark blink</button>
      <button class="btn btn-secondary" onclick={undo} disabled={!marks.length}>Undo</button>
      <span class="muted small">Space = play/pause · B = mark · Backspace = undo</span>
    </div>

    <div class="card">
      <h2>Marks ({marks.length})</h2>
      {#if marks.length}
        <div class="marks">
          {#each marks as m}<span class="mark">{fmt(m.t)}</span>{/each}
        </div>
      {:else}
        <p class="muted">No marks yet.</p>
      {/if}
    </div>

    <div class="card">
      <h2>Clip metadata</h2>
      <div class="row">
        <label class="row" style="gap:6px">
          <input type="checkbox" bind:checked={glasses} /> Glasses
        </label>
        <label class="row" style="gap:6px">
          Lighting
          <select bind:value={lighting}>
            <option value="good">good</option>
            <option value="dim">dim</option>
            <option value="backlit">backlit</option>
          </select>
        </label>
        <input class="notes" type="text" placeholder="Notes…" bind:value={notes} />
      </div>
    </div>

    <div class="row">
      <button class="btn btn-primary" onclick={download} disabled={!fileName}>Download labels</button>
    </div>
  </section>
{/if}

<style>
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .video-wrap {
    padding: 0;
    overflow: hidden;
    background: #000;
    min-height: 240px;
    display: grid;
    place-items: center;
  }
  video {
    display: block;
    max-width: 100%;
    max-height: 70vh;
  }
  .empty {
    position: absolute;
    color: #ccc;
  }
  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .mark {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 2px 10px;
    font-variant-numeric: tabular-nums;
    font-size: 0.85rem;
  }
  .notes {
    flex: 1;
    min-width: 160px;
    font: inherit;
    padding: 8px 12px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }
  .small {
    font-size: 0.82rem;
  }
</style>
