import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VIDEO = process.env.DIAG_VIDEO;
test.skip(!VIDEO, 'Set DIAG_VIDEO to a video path');

test('diag run', async ({ page, browserName }) => {
  test.setTimeout(900_000);
  const forceGpu = process.env.DIAG_FORCE_GPU === '1';
  if (forceGpu) {
    await page.addInitScript(() => localStorage.setItem('eyefd.delegate', 'GPU'));
  }
  const tag = `${process.env.DIAG_TAG ? process.env.DIAG_TAG + '-' : ''}${browserName}${forceGpu ? '-gpu' : ''}`;
  mkdirSync('eval-data', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
  });

  const t0 = Date.now();
  await page.goto('/?dev=1#/check');
  // Pass the path (streams the file); buffers are capped at 50 MB by Playwright.
  await page.locator('input[type="file"]').setInputFiles(VIDEO!);

  // Screenshots of the video card at ~5s, 20s, 40s of wall time after load.
  let shotN = 0;
  for (const atMs of [5000, 20000, 40000]) {
    const wait = atMs - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const card = page.locator('.video-card');
    shotN++;
    try {
      await card.screenshot({ path: `eval-data/diag-${tag}-${shotN}.png`, timeout: 3000 });
    } catch {
      await page.screenshot({ path: `eval-data/diag-${tag}-${shotN}.png` }).catch(() => {});
    }
    if (await page.getByTestId('abstain').isVisible().catch(() => false)) break;
    if (await page.getByTestId('results').isVisible().catch(() => false)) break;
  }

  // Wait for end state.
  let status = 'timeout';
  try {
    await page.waitForSelector(
      '[data-testid="results"],[data-testid="abstain"],h1:has-text("Camera problem")',
      { timeout: 840_000 },
    );
    if (await page.getByTestId('abstain').isVisible()) status = 'abstain';
    else if (await page.getByText('Camera problem').isVisible()) status = 'error';
    else status = 'results';
  } catch {}
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  const data = await page.evaluate(() => {
    const v = document.querySelector('video');
    return {
      videoWidth: v?.videoWidth ?? null,
      videoHeight: v?.videoHeight ?? null,
      duration: v?.duration ?? null,
      userAgent: navigator.userAgent,
      backend: document.querySelector<HTMLElement>('.video-card')?.dataset.backend ?? null,
      endText: document.querySelector('h1')?.textContent ?? null,
      bodyText: document.body.innerText.slice(0, 2000),
      trace: (window as any).__eyefdLastTrace ?? null,
    };
  });

  writeFileSync(
    `eval-data/diag-${tag}.json`,
    JSON.stringify(
      { status, elapsedS, errors, ...data },
      null,
      0,
    ),
  );
  console.log(`[diag] ${tag}: ${status} in ${elapsedS}s, delegate=${data.trace?.delegate}, backend=${data.trace?.backend}, errors=${errors.length}`);
  // Teardown can hang on teardown of the busy video page — navigate away first.
  await page.goto('about:blank').catch(() => {});
});
