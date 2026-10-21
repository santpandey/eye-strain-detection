<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { cameraErrorMessage, VisionClient } from '../lib/vision/client';

  import { guidanceFor as qualityGuidance, QualityCtx, type QualityVerdict } from '../lib/analysis/quality';
  import { QuickCheckAggregator, type QuickCheckResult } from '../lib/analysis/session';
  import { scoreAndLearn, type ScoreView } from '../lib/analysis/scoreSession';
  import { baselineMedian, deltaText, usualDeltaPct } from '../lib/analysis/baseline';
  import { scoreTier } from '../lib/analysis/fatigueScore';
  import { DISCLAIMER, overallVerdict } from '../lib/analysis/thresholds';
  import { CFG } from '../lib/analysis/config';
  import { saveSession, updateSession } from '../lib/storage/db';
  import { isDev } from '../lib/dev';
  import { isStaleModuleError } from '../lib/stale';
  import { RoiTracker } from '../lib/eyeRoi';
  import { fileSession as fs, clock, etaLabel } from '../lib/session/fileSession.svelte';
  import type { FrameFeatures } from '../lib/vision/types';
  import Icon from '../lib/components/Icon.svelte';
  import ProgressRing from '../lib/components/ProgressRing.svelte';
  import StatCard from '../lib/components/StatCard.svelte';
  import AlignmentOverlay from '../lib/components/AlignmentOverlay.svelte';

  type ConsentState = 'checking' | 'ready' | 'nocam' | 'insecure';
  type Phase =
    | 'consent'
    | 'loading'
    | 'align'
    | 'countdown'
    | 'capture'
    | 'results'
    | 'abstain'
    | 'stale'
    | 'error';
  const CAPTURE_MS = CFG.captureMs;
  const ABORT_GAP_MS = CFG.abortGapMs;
  const ALIGN_HOLD_MS = CFG.alignHoldMs;
  const dev = isDev();

  let phase = $state<Phase>('consent');
  let consent = $state<ConsentState>('checking');
  let errorMsg = $state('');
  let guidance = $state('Looking for your face…');
  let aligned = $state(false);
  let countdown = $state(3);
  let paused = $state(false);
  let qualityMs = $state(0);
  let blinkCount = $state(0);
  let result = $state<QuickCheckResult | null>(null);
  /** Fatigue score + baseline context for the results card (null on abstain). */
  let scoreView = $state<ScoreView | null>(null);
  let delegate = $state<string>('');
  let backendKind = $state<string>('');

  let videoEl = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let videoW = $state(640);
  let videoH = $state(480);

  const client = new VisionClient();
  let latest = $state<FrameFeatures | null>(null);
  let alignedSince: number | null = null;
  let countdownTimer = 0;
  let agg: QuickCheckAggregator | null = null;
  let captureStartT: number | null = null;
  let destroyed = false;

  // Normalized alignment frame matching AlignmentOverlay's geometry.
  const FR = { x0: 0.2, x1: 0.8, y0: 0.29, y1: 0.55 };

  let lastVerdict = $state<QualityVerdict | null>(null);
  const aggQuality = new QualityCtx(); // separate ctx used during the align phase

  function checkAlignment(f: FrameFeatures): boolean {
    if (!lastVerdict?.ok) return false;
    const ratio = f.interocularPx / f.frameW;
    if (ratio < 0.18 || ratio > 0.45) return false;
    const [r, l] = f.eyeCenters;
    const inside = (p: [number, number]) =>
      p[0] >= FR.x0 && p[0] <= FR.x1 && p[1] >= FR.y0 && p[1] <= FR.y1;
    return inside(r) && inside(l);
  }

  /** Fallback alignment guidance once all quality gates pass. */
  function alignGuidance(f: FrameFeatures | null): string {
    if (!f || !f.face) return 'Looking for your face…';
    const ratio = f.interocularPx / f.frameW;
    if (ratio < 0.18) return 'Move closer';
    if (ratio > 0.45) return 'Move back a little';
    if (!checkAlignment(f)) return 'Center your eyes in the frame';
    return 'Perfect — hold still';
  }

  const roiTracker = new RoiTracker();
  let eyeClip = $state('');

  function onFeatures(f: FrameFeatures) {
    latest = f;
    roiTracker.push(f);
    eyeClip = roiTracker.css;
    if (phase === 'align') {
      lastVerdict = aggQuality.check(f);
      aligned = checkAlignment(f);
      guidance = qualityGuidance(lastVerdict, alignGuidance(f));
      const now = f.t;
      if (aligned) {
        if (alignedSince === null) alignedSince = now;
        else if (now - alignedSince >= ALIGN_HOLD_MS) startCountdown();
      } else {
        alignedSince = null;
      }
    } else if (phase === 'capture' && agg) {
      if (captureStartT === null) captureStartT = f.t;
      agg.push(f);
      lastVerdict = agg.quality.last ?? null;
      qualityMs = agg.detector.qualityMs;
      blinkCount = agg.detector.events.length;
      paused = !(lastVerdict?.ok ?? false);
      if (qualityMs >= CAPTURE_MS) {
        finish();
      } else if (f.t - captureStartT - agg.detector.qualityMs > ABORT_GAP_MS) {
        fail('We could not get a clear view of your eyes for a while. Try more light, then start again.');
      }
    }
  }

  function mountVideoListener() {
    videoEl?.addEventListener(
      'loadedmetadata',
      () => {
        videoW = videoEl!.videoWidth || 640;
        videoH = videoEl!.videoHeight || 480;
      },
      { once: true },
    );
  }

  async function initPipeline(): Promise<boolean> {
    try {
      client.onDelegateChange = (d) => (delegate = d);
      delegate = await client.init();
      backendKind = client.backendKind ?? '';
      client.onFeatures = onFeatures;
      client.onError = (m) => fail(m);
      client.start();
      return true;
    } catch (e) {
      fail(e ?? new Error('The eye model failed to load.'));
      return false;
    }
  }

  async function start() {
    phase = 'loading';
    errorMsg = '';
    await tick(); // let the video card mount so bind:this assigns videoEl
    try {
      if (!videoEl) throw new Error('Camera preview failed to initialise.');
      mountVideoListener();
      await client.requestCamera(videoEl);
      videoW = videoEl.videoWidth || 640;
      videoH = videoEl.videoHeight || 480;
      if (await initPipeline()) phase = 'align';
    } catch (e) {
      fail(isStaleModuleError(e) ? e : cameraErrorMessage(e));
    }
  }

  function pickFile() {
    fileInput?.click();
  }

  function onFilePicked(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = '';
    if (!file) return;
    // The file session manager owns the pipeline; the video element lives in
    // the app-level mini player so navigation can't interrupt the analysis.
    fs.startFile(file);
  }

  function startCountdown() {
    phase = 'countdown';
    countdown = 3;
    const step = () => {
      if (destroyed) return;
      countdown -= 1;
      if (countdown <= 0) {
        beginCapture();
      } else {
        countdownTimer = window.setTimeout(step, 1000);
      }
    };
    countdownTimer = window.setTimeout(step, 1000);
  }

  function beginCapture() {
    agg = new QuickCheckAggregator();
    agg.traceEnabled = dev;
    agg.begin();
    captureStartT = null;
    qualityMs = 0;
    blinkCount = 0;
    paused = false;
    scoreView = null;
    phase = 'capture';
  }

  function stashTrace(r: QuickCheckResult | null = null) {
    if (!dev || !agg) return;
    (window as unknown as { __blinkwellLastTrace?: unknown }).__blinkwellLastTrace = {
      schema: 1,
      source: 'camera',
      startedAt: agg.startedAt ?? '',
      frames: agg.traceFrames,
      diag: agg.traceDiag,
      events: agg.detector.events,
      delegate: client.delegate,
      backend: client.backendKind,
      renderer: client.renderer,
      delegateTiming: client.delegateTiming,
      result: r,
    };
  }

  async function finish() {
    if (!agg) return;
    const r = agg.result('camera');
    result = r;
    if (dev) stashTrace(r);
    if (r.confidence === 'low') {
      phase = 'abstain';
      teardownCamera();
      return; // low confidence = not saved, no baseline update
    }
    // Score vs the pre-update baseline, then learn, then save — so the stored
    // record carries fatigueScore and this session doesn't anchor its own score.
    scoreView = await scoreAndLearn(r);
    teardownCamera();
    try {
      await saveSession(r);
    } catch {
      // Storage failure shouldn't block the results view.
    }
    phase = 'results';
  }

  function downloadTrace() {
    const w = window as unknown as { __blinkwellLastTrace?: unknown };
    if (!w.__blinkwellLastTrace) return;
    const blob = new Blob([JSON.stringify(w.__blinkwellLastTrace)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `blinkwell-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function reportTired(score: number, isFile: boolean) {
    const cur = isFile ? fs.result : result;
    if (!cur) return;
    const updated = { ...cur, selfReport: score };
    if (isFile) fs.result = updated;
    else result = updated;
    try {
      await updateSession(updated);
    } catch {
      // best effort
    }
  }

  function fail(e: unknown) {
    stashTrace(); // dev: keep partial trace on the error path too
    if (isStaleModuleError(e)) {
      phase = 'stale';
    } else {
      errorMsg = e instanceof Error ? e.message : String(e);
      phase = 'error';
    }
    teardownCamera();
  }

  function cancel() {
    teardownCamera();
    phase = 'consent';
  }

  function teardownCamera() {
    clearTimeout(countdownTimer);
    client.destroy();
  }

  onMount(() => {
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        consent = 'insecure';
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        consent = devices.some((d) => d.kind === 'videoinput') ? 'ready' : 'nocam';
      } catch {
        consent = 'ready'; // enumeration failed — let getUserMedia decide
      }
    })();
    return () => {
      destroyed = true;
      teardownCamera();
    };
  });

  const progress = $derived(qualityMs / CAPTURE_MS);
  const remaining = $derived(Math.max(0, Math.ceil((CAPTURE_MS - qualityMs) / 1000)));
  const usableS = $derived(Math.floor(qualityMs / 1000));
  const targetS = Math.round(CAPTURE_MS / 1000);
  const blinkLabel = $derived(`${blinkCount} ${blinkCount === 1 ? 'blink' : 'blinks'}`);
  const pausedReason = $derived(
    lastVerdict?.reasons.includes('noFace') || !lastVerdict
      ? 'Face not detected'
      : qualityGuidance(lastVerdict, 'Face the camera'),
  );

  // File-session panel derivations.
  const fsUsableS = $derived(Math.floor(fs.usableMs / 1000));

  const EDU_TIPS = [
    'Every 20 minutes, look at something about 6 metres (20 feet) away for 20 seconds — the 20-20-20 rule.',
    'Blink fully: on screens we blink less often and each blink is shallower.',
    'Keep the screen about 50–70 cm from your eyes — roughly an arm’s length.',
    'Match ambient light to the screen — avoid glare and reflections, not light itself.',
    'Put the top of the screen at or slightly below eye level.',
    'Dry room air makes eyes worse — a humidifier or artificial tears can help.',
  ];
  let tipIdx = $state(0);
  $effect(() => {
    if (fs.phase !== 'analyzing') return;
    const t = window.setInterval(() => (tipIdx = (tipIdx + 1) % EDU_TIPS.length), 9000);
    return () => window.clearInterval(t);
  });

  function hero(r: QuickCheckResult): string {
    return overallVerdict(r.statuses);
  }

  function fmt(r: QuickCheckResult) {
    return {
      blinkRate: r.blinkRate.toFixed(0),
      blinkRange: `${r.blinkRateLow.toFixed(0)}–${r.blinkRateHigh.toFixed(0)}`,
      blinks: `${r.completeBlinks} full · ${r.incompleteBlinks} partial`,
      meanBlink: r.statuses.meanBlinkMs === 'na' ? '—' : r.meanBlinkMs.toFixed(0),
      reopen:
        r.statuses.reopenFrac === 'na' || r.meanReopenFrac == null
          ? '—'
          : `${Math.round(r.meanReopenFrac * 100)}`,
      perclos: (r.perclos * 100).toFixed(1),
      maxIbi: (r.maxIbiMs / 1000).toFixed(1),
      distance:
        r.statuses.distanceCm === 'na' || r.distanceCm <= 0
          ? '—'
          : `≈${Math.round(r.distanceCm)}`,
      luma: r.luma.toFixed(0),
      yawns: `${r.yawns}`,
      usable: `${(r.qualityMs / 1000).toFixed(0)}s of ${(r.durationMs / 1000).toFixed(0)}s`,
      fps: r.fpsMean.toFixed(0),
      discards: `${r.gazeDownDiscards + r.asymmetricDiscards}`,
    };
  }

  const tiredLabels = ['Fresh', 'Fine', 'A bit tired', 'Tired', 'Very tired'];
  let whyOpen = $state(false);

  /** "blink rate −38% vs your usual" lines for the score card. */
  function deltaLines(r: QuickCheckResult, sv: ScoreView): string[] {
    const lines: string[] = [];
    const rate = usualDeltaPct(r.blinkRate, baselineMedian(sv.baseline, 'blinkRate'));
    if (rate !== null) lines.push(`blink rate ${deltaText(rate)} vs your usual`);
    for (const p of sv.out.parts) {
      if (p.deltaPct !== null) lines.push(`${p.label} ${deltaText(p.deltaPct)} vs your usual`);
    }
    return lines;
  }
</script>

<input
  bind:this={fileInput}
  type="file"
  accept="video/*"
  class="visually-hidden"
  aria-hidden="true"
  tabindex="-1"
  onchange={onFilePicked}
/>

{#if fs.phase === 'analyzing'}
  <section class="stack" data-testid="file-analyzing">
    <div class="card center stack analyzing-card">
      <h1>Analyzing in the background</h1>
      <p class="muted">
        <strong>{fs.fileName}</strong> is being processed on this device — nothing is
        uploaded. The corner player shows only the eye region we measure. You can keep
        browsing; the player in the corner keeps working.
      </p>
      <div class="bgstats">
        <div class="bgstat">
          <strong data-testid="hud-video-pos">
            {clock(fs.mediaPos)}{#if fs.mediaDur > 0}<span class="muted"> / {clock(fs.mediaDur)}</span>{/if}
          </strong>
          <span class="muted">video</span>
        </div>
        <div class="bgstat">
          <strong data-testid="hud-usable">
            {fsUsableS}s<span class="muted"> / {targetS}s</span>
          </strong>
          <span class="muted">usable footage</span>
        </div>
        <div class="bgstat">
          <strong data-testid="hud-blinks">{fs.blinks}</strong>
          <span class="muted">{fs.blinks === 1 ? 'blink' : 'blinks'}</span>
        </div>
      </div>
      {#if fs.mediaDur === 0 && !fs.paused}
        <p class="muted small">Loading the on-device face model…</p>
      {/if}
      {#if fs.paused}
        <div class="paused-note" data-testid="hud-paused">
          <strong>Paused — {fs.pauseReason}</strong>
          <span>Blinks aren't counted until the face is clearly visible.</span>
          {#if fs.showFramingTip}
            <span class="muted">
              <em>
                Tip: the whole face (forehead to chin) should be in frame, well lit,
                facing the camera.
              </em>
            </span>
          {/if}
        </div>
      {/if}
      {#if fs.slowed || fs.etaS > 0}
        <p class="muted small" data-testid="hud-rate">
          {#if fs.slowed}Analyzing at {fs.rateLabel} speed for accuracy{/if}{#if fs.slowed && fs.etaS > 0} · {/if}{#if fs.etaS > 0}{etaLabel(fs.etaS)}{/if}
        </p>
      {/if}
      <div class="tip-block">
        <h2>While you wait</h2>
        <p aria-live="polite">{EDU_TIPS[tipIdx]}</p>
      </div>
      <div class="row" style="justify-content:center">
        <button class="btn btn-secondary" onclick={() => fs.reset()}>Cancel analysis</button>
        {#if fs.delegate}<span class="muted small">Engine: {fs.delegate}</span>{/if}
      </div>
    </div>
  </section>
{:else if fs.phase === 'done' && fs.result}
  {@render resultsCard(fs.result, true)}
{:else if fs.phase === 'abstain' && fs.result}
  {@render abstainCard(fs.result, true)}
{:else if fs.phase === 'error'}
  {@render errorCard('Video problem', fs.errorMsg, pickFile)}
{:else if fs.phase === 'stale'}
  {@render staleCard()}
{:else if phase === 'consent'}
  {#if consent === 'insecure'}
    <section class="card consent stack">
      <div class="consent-icon warn"><Icon name="warning" size={40} /></div>
      <h1>Secure connection needed</h1>
      <p>Camera access needs a secure connection (https or localhost).</p>
      <button class="btn btn-secondary" onclick={pickFile}>Analyze a video file instead</button>
    </section>
  {:else if consent === 'nocam'}
    <section class="card consent stack" data-testid="nocam">
      <div class="consent-icon"><Icon name="camera" size={40} /></div>
      <h1>No camera detected</h1>
      <p class="muted">Connect a webcam, or open this app on your phone.</p>
      <button class="btn btn-secondary" onclick={pickFile}>Analyze a video file instead</button>
    </section>
  {:else}
    <section class="card consent stack">
      <div class="consent-icon"><Icon name="camera" size={40} /></div>
      <h1>Quick eye check</h1>
      <p>
        We use your camera to measure blinking and eye fatigue for about 90 seconds.
        Once aligned, the view crops to <strong>just your eye region</strong>. Everything is
        processed <strong>on your device</strong> — video is never uploaded and never saved;
        only summary numbers are kept.
      </p>
      <button class="btn btn-primary" onclick={start} disabled={consent === 'checking'}>
        Allow camera
      </button>
      <button class="btn-link" onclick={pickFile}>Analyze a video file instead</button>
    </section>
  {/if}
{:else if phase === 'loading' || phase === 'align' || phase === 'countdown' || phase === 'capture'}
  <section class="stack">
    <div
      class="video-card card"
      style:aspect-ratio="{videoW} / {videoH}"
      data-backend={backendKind}
      data-source="camera"
    >
      <video
        bind:this={videoEl}
        class="preview mirrored"
        playsinline
        muted
        style={phase === 'capture' ? eyeClip : ''}
      ></video>
      {#if phase === 'loading'}
        <div class="loading-overlay">
          <h1>Preparing eye model…</h1>
          <p>Loading the on-device face model.</p>
        </div>
      {:else if videoEl}
        <AlignmentOverlay features={latest} {aligned} frameW={videoW} frameH={videoH} />
      {/if}
      {#if phase === 'countdown'}
        <div class="countdown" aria-live="assertive">{countdown}</div>
      {/if}
      {#if phase === 'capture'}
        <div class="capture-hud">
          <ProgressRing {progress} size={88} stroke={8} />
          <div class="hud-body">
            <div class="hud-line"><strong>{remaining}s</strong> remaining</div>
            <div class="hud-line muted" data-testid="hud-usable">
              Usable footage: {usableS}s of {targetS}s
            </div>
            <div class="hud-line muted" data-testid="hud-blinks">{blinkLabel}</div>
            <div class="hud-paused-region" aria-live="polite">
              {#if paused}
                <div class="hud-paused" data-testid="hud-paused">
                  <div class="hud-paused-reason">Paused — {pausedReason}</div>
                  <div class="hud-paused-note">Blinks aren't counted until your face is clearly visible.</div>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
    {#if phase === 'align'}
      <p class="guidance" aria-live="polite">{guidance}</p>
    {/if}
    <div class="row">
      <button class="btn btn-secondary" onclick={cancel}>Cancel</button>
      {#if delegate}<span class="muted small">Engine: {delegate}</span>{/if}
    </div>
  </section>
{:else if phase === 'results' && result}
  {@render resultsCard(result, false)}
{:else if phase === 'abstain' && result}
  {@render abstainCard(result, false)}
{:else if phase === 'stale'}
  {@render staleCard()}
{:else if phase === 'error'}
  {@render errorCard('Camera problem', errorMsg, start)}
{/if}

{#snippet resultsCard(r: QuickCheckResult, isFile: boolean)}
  {@const v = fmt(r)}
  {@const sv = isFile ? fs.scoreView : scoreView}
  <section class="stack" data-testid="results">
    <div class="card">
      <div class="row" style="justify-content: space-between">
        <h1>{hero(r)}</h1>
        <span class="chip chip-{r.confidence === 'high' ? 'good' : 'watch'}">
          {r.confidence === 'high' ? 'High confidence' : 'Medium confidence'}
        </span>
      </div>
      <p class="muted">
        {new Date(r.startedAt).toLocaleTimeString()}
        {#if r.source === 'file'} · from video file{/if}
      </p>
      {#if r.confidenceReasons.length}
        <button class="btn-link" onclick={() => (whyOpen = !whyOpen)} aria-expanded={whyOpen}>
          Why? {whyOpen ? '▾' : '▸'}
        </button>
        {#if whyOpen}
          <ul class="reasons">
            {#each r.confidenceReasons as reason}<li>{reason.text} — <span class="muted">{reason.fix}</span></li>{/each}
          </ul>
        {/if}
      {/if}
      <div class="datarow muted small">
        <span>Data quality: {v.usable} usable · {v.fps} fps avg · {v.discards} discarded events</span>
      </div>
      {#if sv?.out.score != null}
        {@const tier = scoreTier(sv.out.score)}
        <div class="score-block" data-testid="fatigue-score">
          <div class="row" style="justify-content: space-between">
            <div class="score-line">
              <strong>{sv.out.score} / 100</strong>
              <span class="muted"> — higher means more tired</span>
            </div>
            <span class="chip chip-{tier}">{tier === 'good' ? 'fresh' : tier === 'watch' ? 'tired signs' : 'very tired'}</span>
          </div>
          <div
            class="meter"
            role="meter"
            aria-label="Fatigue score"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={sv.out.score}
          >
            <div class="meter-fill tier-{tier}" style:width="{sv.out.score}%"></div>
          </div>
          {#if sv.out.baselineReady}
            {@const lines = deltaLines(r, sv)}
            {#if lines.length}
              <ul class="delta-list">
                {#each lines as line}<li>{line}</li>{/each}
              </ul>
            {/if}
            <p class="muted small">
              Baseline: your usual from {sv.sessionsSoFar} sessions.
            </p>
          {:else}
            <p class="muted small">
              Building your personal baseline — {Math.min(sv.sessionsSoFar, CFG.baselineMinSessions)}
              of {CFG.baselineMinSessions} checks done.
            </p>
          {/if}
        </div>
      {/if}
    </div>
    <div class="grid">
      <StatCard label="Blink rate" value={v.blinkRate} unit="/min" status={r.statuses.blinkRate} hint={`range ${v.blinkRange}`} />
      <StatCard label="Blinks" value={v.blinks} status={r.statuses.incompleteRatio} hint={r.statuses.incompleteRatio === 'na' ? 'not enough blinks' : 'Partial blinks miss the tear film'} />
      <StatCard label="Blink length" value={v.meanBlink} unit="ms" status={r.statuses.meanBlinkMs} hint={r.statuses.meanBlinkMs === 'na' ? 'not enough blinks' : 'Long, heavy blinks suggest tiredness'} />
      <StatCard label="Reopening" value={v.reopen} unit="%" status={r.statuses.reopenFrac} hint={r.statuses.reopenFrac === 'na' ? 'not enough blinks' : 'Share of each blink spent reopening — tired lids are slow'} />
      <StatCard label="Eye closure" value={v.perclos} unit="%" status={r.statuses.perclos} hint="Time eyes were closed" />
      <StatCard label="Longest gap" value={v.maxIbi} unit="s" status={r.statuses.maxIbiMs} hint="Longest stretch without a blink" />
      <StatCard label="Distance" value={v.distance} unit="cm (approx.)" status={r.statuses.distanceCm} hint={r.statuses.distanceCm === 'na' ? 'not available for video files' : 'Estimated from iris size'} />
      <StatCard label="Light" value={v.luma} status={r.statuses.luma} hint="Face brightness estimate" />
      <StatCard label="Yawns" value={v.yawns} status="good" hint="Jaw open ≥1.5s" />
    </div>
    {#if r.tips.length}
      <div class="card">
        <h2>Tips</h2>
        <ul class="tips">
          {#each r.tips as tip}<li>{tip}</li>{/each}
        </ul>
        <p class="muted small">{DISCLAIMER}</p>
      </div>
    {/if}
    <div class="card">
      <h2>How tired do your eyes feel right now?</h2>
      <div class="row tired-row">
        {#each tiredLabels as label, i}
          <button
            class="tired-chip"
            class:selected={r.selfReport === i + 1}
            onclick={() => reportTired(i + 1, isFile)}
          >
            <strong>{i + 1}</strong> {label}
          </button>
        {/each}
      </div>
    </div>
    <div class="row">
      <button class="btn btn-primary" onclick={() => (isFile ? fs.reset() : cancel())}>
        Check again
      </button>
      <a class="btn btn-secondary" href="#/history">View history</a>
      {#if dev}<button class="btn btn-secondary" onclick={downloadTrace}>Download trace</button>{/if}
    </div>
  </section>
{/snippet}

{#snippet abstainCard(r: QuickCheckResult, isFile: boolean)}
  <section class="card center stack" data-testid="abstain">
    <div class="consent-icon warn"><Icon name="warning" size={40} /></div>
    <h1>Not reliable enough to score</h1>
    <ul class="reasons" style="text-align:left">
      {#each r.confidenceReasons as reason}<li>{reason.text} — <span class="muted">{reason.fix}</span></li>{/each}
    </ul>
    <div class="row" style="justify-content:center">
      <button class="btn btn-primary" onclick={isFile ? pickFile : start}>Try again</button>
      <button class="btn btn-secondary" onclick={() => (isFile ? fs.reset() : cancel())}>Back</button>
      {#if dev}<button class="btn btn-secondary" onclick={downloadTrace}>Download trace</button>{/if}
    </div>
  </section>
{/snippet}

{#snippet staleCard()}
  <section class="card center stack">
    <div class="consent-icon"><Icon name="refresh" size={40} /></div>
    <h1>Refresh needed</h1>
    <p class="muted">
      The app was updated while this page was open. Reload the page, then pick the video
      again — nothing was saved or uploaded.
    </p>
    <div class="row" style="justify-content:center">
      <button class="btn btn-primary" onclick={() => location.reload()}>
        <Icon name="refresh" size={18} /> Reload
      </button>
      <a class="btn btn-secondary" href="#/">Back home</a>
    </div>
  </section>
{/snippet}

{#snippet errorCard(title: string, msg: string, retry: () => void)}
  <section class="card center stack">
    <div class="consent-icon warn"><Icon name="warning" size={40} /></div>
    <h1>{title}</h1>
    <p class="muted">{msg}</p>
    <div class="row" style="justify-content:center">
      <button class="btn btn-primary" onclick={retry}><Icon name="refresh" size={18} /> Retry</button>
      <a class="btn btn-secondary" href="#/">Back home</a>
    </div>
  </section>
{/snippet}

<style>
  .consent,
  .center {
    max-width: 480px;
    margin: 48px auto 0;
    text-align: center;
    align-items: center;
  }
  .consent-icon {
    color: var(--primary);
    background: var(--primary-soft);
    border-radius: 50%;
    width: 72px;
    height: 72px;
    display: grid;
    place-items: center;
  }
  .consent-icon.warn {
    color: var(--high);
    background: var(--high-soft);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .btn-link {
    appearance: none;
    background: none;
    border: none;
    color: var(--primary);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 8px;
    min-height: 44px;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .video-card {
    position: relative;
    overflow: hidden;
    padding: 0;
    background: #000;
  }
  .loading-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    gap: 4px;
    background: var(--surface-2);
    color: var(--text);
  }
  .loading-overlay p {
    color: var(--muted);
  }
  .preview {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .preview.mirrored {
    transform: scaleX(-1);
  }
  .countdown {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 6rem;
    font-weight: 800;
    color: #fff;
    text-shadow: 0 2px 12px rgb(0 0 0 / 0.6);
  }
  .capture-hud {
    position: absolute;
    left: 16px;
    bottom: 16px;
    display: flex;
    gap: 14px;
    align-items: center;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    padding: 10px 16px;
    border-radius: var(--radius-card);
  }
  .capture-hud {
    max-width: min(30rem, calc(100% - 32px));
  }
  .hud-body {
    min-width: 0;
  }
  .capture-hud .hud-line.muted {
    color: rgb(255 255 255 / 0.8);
    font-size: 0.85rem;
  }
  /* Amber notice on the dark HUD: watch token, lightened toward the HUD's
     white text so it keeps ≥4.5:1 contrast in both light and dark themes. */
  .hud-paused {
    margin-top: 6px;
    padding: 6px 10px;
    border-left: 3px solid var(--watch);
    border-radius: 6px;
    background: color-mix(in srgb, var(--watch) 18%, transparent);
    font-size: 0.8rem;
    line-height: 1.35;
  }
  .hud-paused-reason {
    font-weight: 700;
    color: color-mix(in srgb, var(--watch) 55%, #fff);
  }
  .hud-paused-note {
    color: rgb(255 255 255 / 0.9);
  }
  .guidance {
    text-align: center;
    font-size: 1.15rem;
    font-weight: 600;
    min-height: 1.6em;
  }
  .analyzing-card {
    max-width: 560px;
  }
  .bgstats {
    display: flex;
    gap: 24px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .bgstat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 90px;
  }
  .bgstat strong {
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .bgstat .muted {
    font-size: 0.8rem;
  }
  .paused-note {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    border-left: 3px solid var(--watch);
    border-radius: 6px;
    background: var(--watch-soft);
    text-align: left;
    font-size: 0.9rem;
  }
  .paused-note strong {
    color: var(--watch);
  }
  .tip-block {
    background: var(--surface-2);
    border-radius: var(--radius-btn);
    padding: 14px 16px;
    text-align: left;
  }
  .tip-block h2 {
    margin: 0 0 6px;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .tip-block p {
    margin: 0;
    min-height: 2.6em;
  }
  .tips {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  .tips li {
    margin-bottom: 8px;
  }
  .small {
    font-size: 0.82rem;
  }
  .reasons {
    margin: 4px 0 0;
    padding-left: 20px;
  }
  .reasons li {
    margin-bottom: 6px;
    font-size: 0.9rem;
  }
  .datarow {
    margin-top: 8px;
  }
  .score-block {
    margin-top: 14px;
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  .score-line {
    font-size: 1.3rem;
    line-height: 1.2;
  }
  .score-line strong {
    font-variant-numeric: tabular-nums;
  }
  .score-line .muted {
    font-size: 0.85rem;
    font-weight: 400;
  }
  .meter {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
    margin: 10px 0 10px;
  }
  .meter-fill {
    height: 100%;
    border-radius: 999px;
  }
  .tier-good {
    background: var(--good);
  }
  .tier-watch {
    background: var(--watch);
  }
  .tier-high {
    background: var(--high);
  }
  .delta-list {
    list-style: none;
    margin: 4px 0 8px;
    padding: 0;
    font-size: 0.9rem;
  }
  .delta-list li {
    padding: 2px 0;
  }
  .tired-row {
    gap: 8px;
  }
  .tired-chip {
    appearance: none;
    font: inherit;
    font-size: 0.85rem;
    padding: 10px 12px;
    min-height: 44px;
    border-radius: var(--radius-btn);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .tired-chip.selected {
    background: var(--primary);
    color: var(--on-primary);
    border-color: var(--primary);
  }
  .tired-chip strong {
    margin-right: 4px;
  }
</style>
