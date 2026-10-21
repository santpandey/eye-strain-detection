<script lang="ts">
  import Nav from './lib/components/Nav.svelte';
  import MiniPlayer from './lib/components/MiniPlayer.svelte';
  import MonitorWidget from './lib/components/MonitorWidget.svelte';
  import Home from './routes/Home.svelte';
  import Check from './routes/Check.svelte';
  import History from './routes/History.svelte';
  import Settings from './routes/Settings.svelte';
  import DevLabel from './routes/DevLabel.svelte';

  function routeFromHash(): string {
    const h = location.hash.replace(/^#/, '') || '/';
    return ['/', '/check', '/history', '/settings', '/dev/label'].includes(h) ? h : '/';
  }

  let route = $state(routeFromHash());

  $effect(() => {
    const onHash = () => (route = routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
</script>

<Nav {route} />
<main>
  {#key route}
    {#if route === '/'}
      <Home />
    {:else if route === '/check'}
      <Check />
    {:else if route === '/history'}
      <History />
    {:else if route === '/settings'}
      <Settings />
    {:else if route === '/dev/label'}
      <DevLabel />
    {/if}
  {/key}
</main>
<MiniPlayer />
<MonitorWidget />
