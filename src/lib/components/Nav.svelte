<script lang="ts">
  import { isDev } from '../dev';
  import Icon from './Icon.svelte';

  let { route }: { route: string } = $props();

  const items = [
    { href: '#/', icon: 'home', label: 'Home', match: '/' },
    { href: '#/check', icon: 'check', label: 'Check', match: '/check' },
    { href: '#/history', icon: 'history', label: 'History', match: '/history' },
    { href: '#/settings', icon: 'settings', label: 'Settings', match: '/settings' },
    ...(isDev() ? [{ href: '#/dev/label', icon: 'tag', label: 'Label', match: '/dev/label' }] : []),
  ];
</script>

<header class="topbar">
  <div class="topbar-inner">
    <a class="logo" href="#/" aria-label="Eye Fatigue Detector home">
      <span class="logo-icon"><Icon name="eye" size={24} /></span>
      <span class="logo-name">Eye Fatigue Detector</span>
    </a>
    <nav class="tabs" aria-label="Main">
      {#each items as item}
        <a
          class="tab"
          class:active={route === item.match}
          href={item.href}
          aria-current={route === item.match ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>
  </div>
</header>

<nav class="bottombar" aria-label="Main">
  {#each items as item}
    <a
      class="tab"
      class:active={route === item.match}
      href={item.href}
      aria-current={route === item.match ? 'page' : undefined}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </a>
  {/each}
</nav>

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .topbar-inner {
    max-width: var(--content-w);
    margin: 0 auto;
    padding: 10px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--text);
    font-weight: 700;
  }
  .logo-icon {
    color: var(--primary);
    display: inline-flex;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border-radius: var(--radius-btn);
    color: var(--muted);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.9rem;
    transition:
      background 160ms ease,
      color 160ms ease;
  }
  .tab:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .tab.active {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .bottombar {
    display: none;
  }
  @media (max-width: 719px) {
    .topbar-inner .tabs {
      display: none;
    }
    .bottombar {
      display: flex;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 10;
      background: var(--surface);
      border-top: 1px solid var(--border);
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
      justify-content: space-around;
    }
    .bottombar .tab {
      flex-direction: column;
      gap: 2px;
      font-size: 0.7rem;
      padding: 4px 12px;
    }
  }
</style>
