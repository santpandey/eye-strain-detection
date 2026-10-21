<script lang="ts">
  let { name, size = 22 }: { name: string; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'home'}
    <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
  {:else if name === 'check'}
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" />
  {:else if name === 'history'}
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
  {:else if name === 'settings'}
    <circle cx="12" cy="12" r="3.2" /><path
      d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"
    />
  {:else if name === 'eye'}
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle
      cx="12"
      cy="12"
      r="3"
      fill="currentColor"
      stroke="none"
    />
  {:else if name === 'camera'}
    <path d="M4 8h3l2-3h6l2 3h3v12H4Z" /><circle cx="12" cy="14" r="3.5" />
  {:else if name === 'refresh'}
    <path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 3v4h-4" />
  {:else if name === 'tag'}
    <path d="M3 4h7l10 10-7 7L3 11Z" /><circle cx="8" cy="9" r="1.6" fill="currentColor" stroke="none" />
  {:else if name === 'warning'}
    <path d="M12 3 2.5 20h19Z" /><path d="M12 10v4.5" /><circle cx="12" cy="17" r="0.6" fill="currentColor" />
  {/if}
</svg>
