import { test, expect, chromium, type Page } from '@playwright/test';

interface CollectedErrors {
  errors: string[];
  finish(): void;
}

/** Collect pageerror + console.error. Call finish() to assert none were seen. */
function collectErrors(page: Page, allow: RegExp[] = []): CollectedErrors {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((r) => r.test(m.text()))) {
      errors.push(`console: ${m.text()}`);
    }
  });
  return {
    errors,
    finish() {
      expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
    },
  };
}

/**
 * Fake-camera run of the background monitor. Dev overrides shorten the
 * cadence: first window ~3 s in, 3 s capture, next window ~9 s later.
 * The fake cam shows no face, so windows end unsaved — this spec only
 * asserts phase transitions and the camera-release invariant.
 */
test('monitor: windows run on cadence and the camera is released between them', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const ctx = await browser.newContext({
    baseURL: 'http://localhost:5173',
    permissions: ['camera'],
  });
  const page = await ctx.newPage();
  try {
    // MediaPipe/TFLite logs its init chatter via console.error — allow it.
    const col = collectErrors(page, [/TensorFlow|XNNPACK|W1019|I1019|gl_context|Graph successfully/]);
    await page.addInitScript(() => {
      localStorage.setItem('eyefd.dev', '1');
      localStorage.setItem(
        'eyefd.monitorCfg',
        JSON.stringify({ intervalMs: 9000, windowMs: 3000, breakEveryMs: 60000 }),
      );
    });
    await page.goto('/#/');
    await page.getByTestId('monitor-start').click();

    const widget = page.getByTestId('monitor-widget');
    await expect(widget).toBeVisible();
    await expect(widget).toHaveAttribute('data-phase', 'waiting');
    await expect(page.getByTestId('monitor-chip')).toBeVisible();

    // First window: arming includes the first model init — allow generous time.
    await expect(widget).toHaveAttribute('data-phase', 'capturing', { timeout: 60_000 });
    // Camera is on: the widget's preview video holds the stream.
    const hasStream = await page
      .locator('[data-testid="monitor-widget"] video')
      .evaluate((v: HTMLVideoElement) => v.srcObject !== null);
    expect(hasStream).toBe(true);

    // ~3 s window ends → back to waiting, video unmounts → no srcObject anywhere.
    await expect(widget).toHaveAttribute('data-phase', 'waiting', { timeout: 30_000 });
    const anyStream = await page.evaluate(() =>
      [...document.querySelectorAll('video')].some((v) => v.srcObject !== null),
    );
    expect(anyStream, 'camera tracks must be released between windows').toBe(false);

    // Second window arrives on the short dev cadence (backend kept alive → fast arm).
    await expect(widget).toHaveAttribute('data-phase', 'capturing', { timeout: 30_000 });
    await expect(widget).toHaveAttribute('data-phase', 'waiting', { timeout: 30_000 });
    const anyStream2 = await page.evaluate(() =>
      [...document.querySelectorAll('video')].some((v) => v.srcObject !== null),
    );
    expect(anyStream2).toBe(false);

    // Stop tears everything down to idle (widget hides).
    await page.getByTestId('monitor-chip').getByRole('button', { name: 'Stop monitor' }).click();
    await expect(widget).toHaveCount(0);
    col.finish();
  } finally {
    await ctx.close();
    await browser.close();
  }
});
