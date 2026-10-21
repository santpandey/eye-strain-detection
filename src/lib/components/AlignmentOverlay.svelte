<script lang="ts">
  import type { FrameFeatures } from '../vision/types';

  let {
    features,
    aligned,
    frameW,
    frameH,
  }: {
    features: FrameFeatures | null;
    aligned: boolean;
    frameW: number;
    frameH: number;
  } = $props();

  // Alignment frame: centered, 60% width, 26% height, vertical centre at 42%.
  const fx = $derived(frameW * 0.2);
  const fy = $derived(frameH * (0.42 - 0.13));
  const fw = $derived(frameW * 0.6);
  const fh = $derived(frameH * 0.26);
  const fr = 24;

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
  {#if contourPath}
    <path d={contourPath} fill="none" stroke="var(--primary)" stroke-width="2" opacity="0.85" />
  {/if}
</svg>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
