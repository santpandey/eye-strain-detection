<script lang="ts">
  let {
    progress,
    size = 120,
    stroke = 10,
  }: { progress: number; size?: number; stroke?: number } = $props();

  const r = $derived((size - stroke) / 2);
  const c = $derived(2 * Math.PI * r);
  const offset = $derived(c * (1 - Math.max(0, Math.min(1, progress))));
</script>

<svg width={size} height={size} role="progressbar" aria-valuenow={Math.round(progress * 100)}>
  <circle cx={size / 2} cy={size / 2} {r} fill="none" stroke="var(--surface-2)" stroke-width={stroke} />
  <circle
    cx={size / 2}
    cy={size / 2}
    {r}
    fill="none"
    stroke="var(--primary)"
    stroke-width={stroke}
    stroke-linecap="round"
    stroke-dasharray={c}
    stroke-dashoffset={offset}
    transform="rotate(-90 {size / 2} {size / 2})"
    style="transition: stroke-dashoffset 180ms linear"
  />
  <text
    x="50%"
    y="50%"
    text-anchor="middle"
    dominant-baseline="central"
    fill="var(--text)"
    font-weight="700"
    font-size={size / 5}
  >
    {Math.round(progress * 100)}%
  </text>
</svg>
