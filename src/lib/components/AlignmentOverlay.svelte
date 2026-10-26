<script lang="ts">
  import type { FrameFeatures } from '../vision/types';

  let {
    features,
    aligned,
    frameW,
    frameH,
    holdFrac = 0,
  }: {
    features: FrameFeatures | null;
    aligned: boolean;
    frameW: number;
    frameH: number;
    /** 0–1 progress through the "hold still" window; sweeps the frame green. */
    holdFrac?: number;
  } = $props();

  // Alignment frame: centered, 60% width, 26% height, vertical centre at 42%.
  const fx = $derived(frameW * 0.2);
  const fy = $derived(frameH * (0.42 - 0.13));
  const fw = $derived(frameW * 0.6);
  const fh = $derived(frameH * 0.26);
  const fr = 24;
  const cx = $derived(fx + fw / 2);
  const cy = $derived(fy + fh / 2);
  const m = $derived(Math.min(frameW, frameH));

  // Head outline: when the face fills the oval, the eyes land in the band.
  const headRx = $derived(m * 0.2);
  const headRy = $derived(m * 0.31);
  const headCy = $derived(frameH * 0.48);

  // Target eye positions: mid-band of the accepted interocular range
  // (0.18–0.45 of frame width), so matching rings also fixes distance.
  const eyeGap = $derived(frameW * 0.13);
  const ghostL = $derived<[number, number]>([cx - eyeGap, cy]);
  const ghostR = $derived<[number, number]>([cx + eyeGap, cy]);

  // Live eye positions. Landmark coords are unmirrored; the preview is
  // mirrored via CSS, so mirror x here to match what the user sees.
  const eyes = $derived.by((): [number, number][] => {
    if (!features?.face) return [];
    return features.eyeCenters.map(([x, y]) => [(1 - x) * frameW, y * frameH]);
  });

  // Direction nudges shown while an eye sits outside the band, in displayed
  // coords — the chevron points the way the on-screen face should drift.
  const chevrons = $derived.by((): { points: string; cls: string }[] => {
    if (aligned || eyes.length < 2) return [];
    const a = m * 0.032; // chevron arm
    const b = a * 1.05; // half-height
    const pad = m * 0.034;
    const step = a * 1.1; // gap between the double strokes
    const out = {
      l: eyes.some((e) => e[0] < fx),
      r: eyes.some((e) => e[0] > fx + fw),
      t: eyes.some((e) => e[1] < fy),
      b: eyes.some((e) => e[1] > fy + fh),
    };
    const chevs: { points: string; cls: string }[] = [];
    // Both horizontal outs at once = too close to the camera, not a drift —
    // distance is covered by the ring-vs-dot spacing and the guidance line.
    if (out.l && !out.r) {
      for (let i = 0; i < 2; i++) {
        const px = fx - pad - i * step;
        chevs.push({ points: `${px - a},${cy - b} ${px},${cy} ${px - a},${cy + b}`, cls: 'n-h' });
      }
    }
    if (out.r && !out.l) {
      for (let i = 0; i < 2; i++) {
        const px = fx + fw + pad + i * step;
        chevs.push({ points: `${px + a},${cy - b} ${px},${cy} ${px + a},${cy + b}`, cls: 'n-h' });
      }
    }
    if (out.t) {
      for (let i = 0; i < 2; i++) {
        const py = fy - pad - i * step;
        chevs.push({ points: `${cx - b},${py - a} ${cx},${py} ${cx + b},${py - a}`, cls: 'n-v' });
      }
    }
    if (out.b) {
      for (let i = 0; i < 2; i++) {
        const py = fy + fh + pad + i * step;
        chevs.push({ points: `${cx - b},${py + a} ${cx},${py} ${cx + b},${py + a}`, cls: 'n-v' });
      }
    }
    return chevs;
  });

  // Contour is in normalized coords of the (unmirrored) frame. The video is
  // mirrored via CSS, so mirror x here to match what the user sees.
  // Two closed subpaths: points 0-5 (right eye), 6-11 (left eye).
  const contourPath = $derived.by(() => {
    if (!features || !features.face || features.eyeContour.length < 24) return '';
    const pts = features.eyeContour;
    const sub = (from: number) => {
      let d = '';
      for (let i = from; i < from + 12; i += 2) {
        const x = (1 - pts[i]) * frameW;
        const y = pts[i + 1] * frameH;
        d += `${i === from ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
      }
      return d + 'Z';
    };
    return sub(0) + ' ' + sub(12);
  });
</script>

<svg
  class="overlay"
  viewBox="0 0 {frameW} {frameH}"
  preserveAspectRatio="none"
  aria-hidden="true"
>
  <defs>
    <mask id="dim-mask">
      <rect width={frameW} height={frameH} fill="white" />
      <rect x={fx} y={fy} width={fw} height={fh} rx={fr} fill="black" />
    </mask>
  </defs>
  <rect width={frameW} height={frameH} fill="rgb(0 0 0 / 0.45)" mask="url(#dim-mask)" />

  <ellipse
    {cx}
    cy={headCy}
    rx={headRx}
    ry={headRy}
    fill="none"
    stroke="rgb(255 255 255 / 0.45)"
    stroke-width={m * 0.006}
  />
  {#each [ghostL, ghostR] as g}
    <circle
      cx={g[0]}
      cy={g[1]}
      r={m * 0.028}
      fill="none"
      stroke={aligned ? 'var(--good)' : 'rgb(255 255 255 / 0.7)'}
      stroke-width={m * 0.006}
      style="transition: stroke 180ms ease"
    />
  {/each}
  {#each chevrons as c}
    <polyline
      points={c.points}
      class={c.cls}
      fill="none"
      stroke="rgb(255 255 255 / 0.95)"
      stroke-width={m * 0.009}
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/each}

  <rect
    x={fx}
    y={fy}
    width={fw}
    height={fh}
    rx={fr}
    fill="var(--good)"
    opacity={aligned ? 0.15 : 0}
    style="transition: opacity 200ms ease"
  />
  <rect
    x={fx}
    y={fy}
    width={fw}
    height={fh}
    rx={fr}
    fill="none"
    stroke={aligned ? 'var(--good)' : 'rgb(255 255 255 / 0.8)'}
    stroke-width="3"
    style="transition: stroke 180ms ease"
  />
  {#if holdFrac > 0}
    <rect
      x={fx}
      y={fy}
      width={fw}
      height={fh}
      rx={fr}
      fill="none"
      stroke="var(--good)"
      stroke-width="5"
      pathLength="1"
      stroke-dasharray="1"
      stroke-dashoffset={1 - Math.min(1, Math.max(0, holdFrac))}
      stroke-linecap="round"
      opacity="0.9"
    />
  {/if}

  {#if contourPath}
    <path d={contourPath} fill="none" stroke="var(--primary)" stroke-width="2" opacity="0.8" />
  {/if}
  {#each eyes as e}
    <circle
      cx={e[0]}
      cy={e[1]}
      r={m * 0.016}
      fill={aligned ? 'var(--good)' : '#fff'}
      stroke="rgb(0 0 0 / 0.55)"
      stroke-width="2"
      style="transition: fill 180ms ease"
    />
  {/each}
</svg>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .n-h {
    animation: nudge-x 900ms ease-in-out infinite;
  }
  .n-v {
    animation: nudge-y 900ms ease-in-out infinite;
  }
  @keyframes nudge-x {
    50% {
      transform: translateX(6px);
    }
  }
  @keyframes nudge-y {
    50% {
      transform: translateY(6px);
    }
  }
</style>
