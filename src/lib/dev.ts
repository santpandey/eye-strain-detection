/** Developer mode: localStorage flag or ?dev=1 in the URL. */
const KEY = 'eyefd.dev';

export function isDev(): boolean {
  try {
    if (new URLSearchParams(location.search).get('dev') === '1') return true;
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setDev(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
