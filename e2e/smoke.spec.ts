import { test, expect, chromium, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const SHOTS = 'e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });

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

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function navAll(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'How are your eyes' })).toBeVisible();
  await page.getByRole('link', { name: 'Check' }).first().click();
  // On camera-less machines the consent card is replaced by "No camera detected".
  await expect(page.getByText(/Quick eye check|No camera detected/)).toBeVisible();
  await page.getByRole('link', { name: 'History' }).first().click();
  await expect(page.getByText('No checks yet')).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('heading', { name: 'How are your eyes' })).toBeVisible();
}

test('navigation renders on desktop', async ({ page }) => {
  const col = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await navAll(page);
  col.finish();
});

test('navigation renders on mobile', async ({ page }) => {
  const col = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await navAll(page);
  col.finish();
});

test('screenshots: home + consent', async ({ page }) => {
  const col = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await shot(page, 'home-desktop-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'home-desktop-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300); // let theme transitions settle
  await shot(page, 'home-mobile-light');
  await page.goto('/#/check');
  await expect(page.getByText(/Quick eye check|No camera detected/)).toBeVisible();
  await shot(page, 'consent');
  col.finish();
});

test.describe('no camera', () => {
  test('shows friendly no-camera UI', async ({ page, browserName }) => {
    const col = collectErrors(page);
    await page.goto('/#/check');
    // Either the proactive "No camera detected" card appears, or clicking
    // Allow yields the friendly error — accept both, require no crash.
    const allow = page.getByRole('button', { name: 'Allow camera' });
    // Wait for consent to resolve (enumerateDevices can be slow headless):
    // nocam card text OR an enabled Allow button — whichever comes first.
    const state = await page.waitForFunction(
      () => {
        if (document.body.innerText.includes('No camera detected')) return 'nocam';
        const b = [...document.querySelectorAll('button')].find(
          (x) => x.textContent?.includes('Allow camera') && !(x as HTMLButtonElement).disabled,
        );
        return b ? 'allow' : '';
      },
      undefined,
      { timeout: 30_000 },
    );
    if ((await state.jsonValue()) === 'allow') {
      await allow.click();
      await expect(page.getByText('Camera problem')).toBeVisible({ timeout: 15_000 });
    }
    // 'nocam' case: the card is already confirmed visible by the wait.
    await shot(page, 'no-camera');
    col.finish();
  });
});

test.describe('fake camera', () => {
  test('reaches align phase; reports backend', async () => {
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
    await page.goto('/#/check');
    await page.getByRole('button', { name: 'Allow camera' }).click();
    const guidance = page.locator('.guidance');
    await expect(guidance).toHaveText('Looking for your face…', { timeout: 60_000 });
    await expect(page.getByText(/Engine: (GPU|CPU)/)).toBeVisible();
    const backend = await page.locator('.video-card').getAttribute('data-backend');
    console.log(`[e2e] inference backend: ${backend}`);
    expect(['worker', 'main']).toContain(backend);
    await shot(page, 'align-fakecam');
    col.finish();
    } finally {
      await ctx.close();
      await browser.close();
    }
  });
});

test.describe('video file source', () => {
  test('feeds a generated clip and ends in the not-enough-footage card', async ({ page }) => {
    test.setTimeout(120_000);
    const col = collectErrors(page, [/TensorFlow|XNNPACK|W1019|I1019|gl_context|Graph successfully/]);
    await page.goto('/#/check');

    // Build a tiny synthetic clip in-browser (no ffmpeg on this machine).
    const b64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d')!;
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      const t0 = performance.now();
      await new Promise<void>((done) => {
        const draw = () => {
          const el = (performance.now() - t0) / 1000;
          ctx.fillStyle = `hsl(${el * 60}, 40%, 50%)`;
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = 'white';
          ctx.font = '60px sans-serif';
          ctx.fillText(el.toFixed(1), 280, 250);
          if (el < 3) requestAnimationFrame(draw);
          else done();
        };
        draw();
      });
      const blob = await new Promise<Blob>((done) => {
        rec.onstop = () => done(new Blob(chunks, { type: 'video/webm' }));
        rec.stop();
      });
      const buf = await blob.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    });
    const buf = Buffer.from(b64, 'base64');
    expect(buf.length).toBeGreaterThan(1000);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'clip.webm',
      mimeType: 'video/webm',
      buffer: buf,
    });

    // The analysis runs in the persistent mini player, not on the Check page.
    const mini = page.getByTestId('mini-player');
    await expect(mini).toBeVisible({ timeout: 30_000 });

    // Navigating away mid-analysis keeps the mini player (and session) alive.
    await page.getByRole('link', { name: 'History' }).first().click();
    await expect(page.getByText('No checks yet')).toBeVisible();
    await expect(mini).toBeVisible();

    // Back on Check the session's end state renders automatically.
    await page.getByRole('link', { name: 'Check' }).first().click();
    await expect(page.getByTestId('abstain')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Not reliable enough to score')).toBeVisible();
    await shot(page, 'abstain');
    col.finish();
  });
});

test.describe('dev mode', () => {
  test('?dev=1 shows Label nav and label route renders', async ({ page }) => {
    const col = collectErrors(page);
    await page.goto('/?dev=1#/');
    await expect(page.getByRole('link', { name: 'Label' }).first()).toBeVisible();
    await page.goto('/?dev=1#/dev/label');
    await expect(page.getByRole('heading', { name: 'Label blinks' })).toBeVisible();
    await page.waitForTimeout(500);
    try {
      await page.screenshot({ path: `${SHOTS}/dev-label.png` });
    } catch {
      console.log('[e2e] label screenshot failed (headless quirk), continuing');
    }
    col.finish();
  });

  test('label tool: load clip, step, mark, undo, download', async ({ page }) => {
    const clip = 'eval-data/WhatsApp Video 2026-10-19 at 7.07.15 PM.mp4';
    test.skip(!existsSync(clip), 'real clip not present');
    test.setTimeout(60_000);
    const col = collectErrors(page);
    await page.goto('/?dev=1#/dev/label');
    await expect(page.getByRole('heading', { name: 'Label blinks' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(clip);
    const video = page.locator('video');
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(70);

    // Button path: step forward 30 frames and mark.
    for (let i = 0; i < 30; i++) await page.getByRole('button', { name: '1 frame ▶' }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.9);
    await page.getByRole('button', { name: /mark blink/ }).click();
    // Keyboard path (focus is still on a button): Space plays, Space pauses, B marks.
    await page.keyboard.press('Space');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
    await page.waitForTimeout(800);
    await page.keyboard.press('Space');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('b');
    await page.keyboard.press('b');
    await expect(page.getByRole('heading', { name: 'Marks (3)' })).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('heading', { name: 'Marks (2)' })).toBeVisible();

    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download labels' }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe('WhatsApp Video 2026-10-19 at 7.07.15 PM.labels.json');
    const json = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    expect(json.blinks).toHaveLength(2);
    expect(json.blinks[0].t).toBeGreaterThan(900);
    expect(json.blinks[1].t).toBeGreaterThan(json.blinks[0].t);
    expect(json.durationMs).toBeGreaterThan(70_000);
    await page.screenshot({ path: `${SHOTS}/dev-label-loaded.png` });
    col.finish();
  });
});
