import { mount } from 'svelte';
import App from './App.svelte';
import './styles/tokens.css';
import './styles/base.css';

// A lazy chunk that fails to load means the page predates the deployed build
// (or the dev server restarted) — reload once to get matching code.
window.addEventListener('vite:preloadError', () => {
  if (sessionStorage.getItem('blinkwell.reloaded')) return;
  sessionStorage.setItem('blinkwell.reloaded', '1');
  location.reload();
});

const app = mount(App, { target: document.getElementById('app')! });

export default app;
