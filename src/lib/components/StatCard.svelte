<script lang="ts">
  import type { Status } from '../analysis/thresholds';

  let {
    label,
    value,
    unit = '',
    status = 'good',
    hint = '',
  }: { label: string; value: string; unit?: string; status?: Status; hint?: string } = $props();
</script>

<div class="stat card">
  <div class="stat-top">
    <span class="label">{label}</span>
    <span class="chip chip-{status}">{status}</span>
  </div>
  <div class="value">{value}<span class="unit">{unit}</span></div>
  {#if hint}<div class="hint muted">{hint}</div>{/if}
</div>

<style>
  .stat {
    padding: 14px 16px;
  }
  .stat-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .label {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 600;
  }
  .value {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 6px 0 2px;
  }
  .unit {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--muted);
    margin-left: 4px;
  }
  .hint {
    font-size: 0.78rem;
  }
</style>
