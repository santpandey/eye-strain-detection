<script lang="ts">
  import { clearAll, resetBaseline } from '../lib/storage/db';
  import { isDev, setDev } from '../lib/dev';
  import {
    disableNotifications,
    enableNotifications,
    notificationPermission,
    notificationsEnabled,
    type NotifyPermission,
  } from '../lib/monitor/notify';

  type Theme = 'system' | 'light' | 'dark';
  let theme = $state<Theme>('system');
  let confirming = $state(false);
  let deleted = $state(false);
  let confirmingBaseline = $state(false);
  let baselineReset = $state(false);
  let devOn = $state(isDev());
  let advancedOpen = $state(false);
  let notifyOn = $state(notificationsEnabled());
  let notifyPerm = $state<NotifyPermission>(notificationPermission());

  async function toggleNotify() {
    if (notifyOn) {
      // bind:checked already flipped it — this branch means "turn on".
      notifyOn = await enableNotifications();
      notifyPerm = notificationPermission();
    } else {
      disableNotifications();
    }
  }

  function toggleDev() {
    devOn = !devOn;
    setDev(devOn);
  }

  if (typeof localStorage !== 'undefined') {
    const t = localStorage.getItem('efd-theme');
    if (t === 'light' || t === 'dark') theme = t;
  }

  function setTheme(t: Theme) {
    theme = t;
    if (t === 'system') {
      localStorage.removeItem('efd-theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('efd-theme', t);
      document.documentElement.dataset.theme = t;
    }
  }

  async function deleteAll() {
    await clearAll();
    localStorage.removeItem('efd-theme');
    confirming = false;
    deleted = true;
    setTimeout(() => (deleted = false), 3000);
  }

  async function doResetBaseline() {
    await resetBaseline();
    confirmingBaseline = false;
    baselineReset = true;
    setTimeout(() => (baselineReset = false), 3000);
  }
</script>

<section class="stack">
  <h1>Settings</h1>

  <div class="card">
    <h2>Theme</h2>
    <div class="row" role="radiogroup" aria-label="Theme">
      {#each ['system', 'light', 'dark'] as t}
        <button
          class="btn"
          class:btn-primary={theme === t}
          class:btn-secondary={theme !== t}
          onclick={() => setTheme(t as Theme)}
          role="radio"
          aria-checked={theme === t}
        >
          {t[0].toUpperCase() + t.slice(1)}
        </button>
      {/each}
    </div>
  </div>

  <div class="card">
    <h2>Notifications</h2>
    {#if notifyPerm === 'unsupported'}
      <p class="muted small">This browser doesn't support notifications.</p>
    {:else}
      <label class="row dev-row">
        <input type="checkbox" bind:checked={notifyOn} onchange={toggleNotify} />
        <span>
          <strong>Browser notifications for break reminders</strong><br />
          <span class="muted small">
            Reminders always appear in the app while monitoring is on — this also sends an OS
            notification. Nothing is sent to a server.
          </span>
        </span>
      </label>
      {#if notifyPerm === 'denied'}
        <p class="muted small" data-testid="notify-denied">
          Your browser blocked notifications — enable them in the address-bar/site settings.
        </p>
      {/if}
    {/if}
  </div>

  <div class="card">
    <h2>Your data</h2>
    <p class="muted">All results are stored only in this browser (IndexedDB). Nothing is uploaded.</p>
    {#if confirming}
      <p><strong>Delete every stored check?</strong> This cannot be undone.</p>
      <div class="row">
        <button class="btn btn-danger" onclick={deleteAll}>Yes, delete everything</button>
        <button class="btn btn-secondary" onclick={() => (confirming = false)}>Keep my data</button>
      </div>
    {:else}
      <button class="btn btn-danger" onclick={() => (confirming = true)}>Delete all data</button>
      {#if deleted}<p class="muted">All data deleted.</p>{/if}
    {/if}
    <hr class="divider" />
    <h3>Personal baseline</h3>
    <p class="muted small">Baseline learns from your saved checks on this device only.</p>
    {#if confirmingBaseline}
      <p><strong>Reset your personal baseline?</strong> Scores will be compared against population
        levels until three new checks build a fresh baseline.</p>
      <div class="row">
        <button class="btn btn-danger" onclick={doResetBaseline}>Yes, reset baseline</button>
        <button class="btn btn-secondary" onclick={() => (confirmingBaseline = false)}>Keep it</button>
      </div>
    {:else}
      <button class="btn btn-secondary" onclick={() => (confirmingBaseline = true)}>
        Reset personal baseline
      </button>
      {#if baselineReset}<p class="muted">Baseline reset.</p>{/if}
    {/if}
  </div>

  <div class="card">
    <button class="adv-toggle" onclick={() => (advancedOpen = !advancedOpen)} aria-expanded={advancedOpen}>
      Advanced <span>{advancedOpen ? '▾' : '▸'}</span>
    </button>
    {#if advancedOpen}
      <label class="row dev-row">
        <input type="checkbox" checked={devOn} onchange={toggleDev} />
        <span>
          <strong>Developer tools</strong><br />
          <span class="muted small">Trace download after checks and a blink-labeling tool (adds a “Label” tab after reload).</span>
        </span>
      </label>
    {/if}
  </div>

  <div class="card">
    <h2>About & privacy</h2>
    <p class="muted">
      Eye Fatigue Detector estimates blink patterns and eye tiredness from your webcam using an
      on-device face model. Video frames are analysed in memory and discarded immediately —
      no images or video are uploaded or stored. Only your summary metrics are kept, locally,
      in your browser. Wellness guidance, not a medical diagnosis.
    </p>
  </div>
</section>

<style>
  .adv-toggle {
    appearance: none;
    background: none;
    border: none;
    font: inherit;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
    padding: 0;
    display: flex;
    justify-content: space-between;
    width: 100%;
    min-height: 44px;
    align-items: center;
  }
  .dev-row {
    align-items: flex-start;
    padding: 8px 0;
    cursor: pointer;
  }
  .dev-row input {
    margin-top: 4px;
  }
  .small {
    font-size: 0.82rem;
  }
  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 16px 0;
  }
  h3 {
    font-size: 1rem;
    margin: 0 0 8px;
  }
</style>
