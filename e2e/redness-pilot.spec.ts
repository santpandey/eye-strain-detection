import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Redness pilot: is a webcam-resolvable sclera-redness signal above the noise?
 *
 * For each video in REDNESS_VIDEOS (comma-separated) this loads the file
 * straight into a <video> element, runs the same FaceLandmarker the app uses,
 * and per ~2 s sample:
 *   - extracts the sclera region (eye-contour polygon minus iris disk)
 *   - samples a skin reference patch (cheek box around landmarks 205/425)
 *   - computes a skin-normalized redness index + red-pixel fraction
 *   - records resolution proxies (sclera px, iris px) and EAR for gating
 *
 * Written as a spec (not a unit) because it needs a real video decode +
 * MediaPipe in a browser. Output: eval-data/redness-<clip>-<browser>.json.
 */

const VIDEOS = (process.env.REDNESS_VIDEOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
test.skip(VIDEOS.length === 0, 'Set REDNESS_VIDEOS to comma-separated video paths');

const SAMPLE_EVERY_MS = 2000;

test('redness pilot', async ({ page, browserName }) => {
  test.setTimeout(600_000);
  mkdirSync('eval-data', { recursive: true });

  await page.goto('/?dev=1#/check');
  // A throwaway <input type=file> so setInputFiles can hand us the (large) file.
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'pilot-input';
    inp.style.display = 'none';
    document.body.appendChild(inp);
  });
  const input = page.locator('#pilot-input');

  for (const videoPath of VIDEOS) {
    await input.setInputFiles(videoPath);

    const out = await page.evaluate(async (sampleEveryMs) => {
      const { FaceLandmarker, FilesetResolver } = await import(
        /* @vite-ignore */ '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs'
      );
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
      });

      const file = document.querySelector<HTMLInputElement>('#pilot-input')!.files![0];
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(file);
      await new Promise<void>((res) => {
        video.onloadedmetadata = () => res();
      });
      const W = video.videoWidth;
      const H = video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

      // Same contours the app uses (features.ts).
      const CONTOUR_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
      const CONTOUR_L = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
      const EAR_R = [33, 160, 158, 133, 153, 144];
      const EAR_L = [362, 385, 387, 263, 373, 380];
      const IRIS = {
        R: { c: 468, ring: [469, 470, 471, 472] },
        L: { c: 473, ring: [474, 475, 476, 477] },
      };
      const CHEEK = { R: 205, L: 425 };

      const px = (p: { x: number; y: number }) => [p.x * W, p.y * H] as const;
      const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        const [ax, ay] = px(a);
        const [bx, by] = px(b);
        return Math.hypot(ax - bx, ay - by);
      };
      const ear = (lm: { x: number; y: number }[], idx: number[]) => {
        const [p1, p2, p3, p4, p5, p6] = idx.map((i) => lm[i]);
        const n = dist(p2, p6) + dist(p3, p5);
        const d = 2 * dist(p1, p4);
        return d > 0 ? n / d : 0;
      };

      function pointInPoly(x: number, y: number, poly: number[]): boolean {
        let inside = false;
        for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
          const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }

      interface Chan { r: number; g: number; b: number; n: number; red: number; sat: number }
      function accRegion(
        data: Uint8ClampedArray,
        test: (x: number, y: number) => boolean,
        x0: number, y0: number, x1: number, y1: number,
      ): Chan {
        const c: Chan = { r: 0, g: 0, b: 0, n: 0, red: 0, sat: 0 };
        for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1); y++) {
          for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1); x++) {
            if (!test(x, y)) continue;
            const i = (y * W + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            c.r += r; c.g += g; c.b += b; c.n++;
            if (r > g * 1.15 && r > b * 1.15) c.red++;
            if (r > 245 || g > 245 || b > 245) c.sat++;
          }
        }
        return c;
      }
      const mean = (c: Chan) =>
        c.n > 0 ? { r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, redFrac: c.red / c.n, satFrac: c.sat / c.n, n: c.n } : null;

      const samples: unknown[] = [];
      const dur = video.duration;
      for (let t = 1; t < dur - 0.5; t += sampleEveryMs / 1000) {
        video.currentTime = t;
        await new Promise<void>((res) => {
          video.onseeked = () => res();
          setTimeout(res, 1500); // don't hang on a bad seek
        });
        ctx.drawImage(video, 0, 0);
        const res = landmarker.detectForVideo(video, Math.round(t * 1000));
        const lm = res.faceLandmarks?.[0];
        if (!lm || lm.length < 478) {
          samples.push({ t: Math.round(t * 1000), face: false });
          continue;
        }
        const frame = ctx.getImageData(0, 0, W, H).data;
        const eyes: Record<string, unknown> = {};
        for (const side of ['R', 'L'] as const) {
          const contour = (side === 'R' ? CONTOUR_R : CONTOUR_L).flatMap((i) => px(lm[i]));
          const ic = lm[IRIS[side].c];
          const ring = IRIS[side].ring;
          const irisR = (dist(lm[ring[0]], lm[ring[2]]) + dist(lm[ring[1]], lm[ring[3]])) / 4;
          const [icx, icy] = px(ic);
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (let i = 0; i < contour.length; i += 2) {
            x0 = Math.min(x0, contour[i]); y0 = Math.min(y0, contour[i + 1]);
            x1 = Math.max(x1, contour[i]); y1 = Math.max(y1, contour[i + 1]);
          }
          const eyeW = x1 - x0, eyeH = y1 - y0;
          const irisR2 = irisR * 1.15;
          const sclera = accRegion(
            frame,
            (x, y) =>
              pointInPoly(x, y, contour) && (x - icx) ** 2 + (y - icy) ** 2 > irisR2 * irisR2,
            x0, y0, x1, y1,
          );
          // Skin reference: box around the cheek landmark, half eye-height.
          const [cxp, cyp] = px(lm[CHEEK[side]]);
          const half = Math.max(3, eyeH * 0.4);
          const skin = accRegion(frame, () => true, cxp - half, cyp - half, cxp + half, cyp + half);
          eyes[side] = {
            ear: ear(lm, side === 'R' ? EAR_R : EAR_L),
            eyeW, eyeH,
            irisPx: irisR * 2,
            sclera: mean(sclera),
            skin: mean(skin),
          };
        }
        samples.push({ t: Math.round(t * 1000), face: true, eyes });
      }
      landmarker.close();
      URL.revokeObjectURL(video.src);
      return { w: W, h: H, dur, samples };
    }, SAMPLE_EVERY_MS);

    const name = videoPath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
    const file = `eval-data/redness-${name}-${browserName}.json`;
    writeFileSync(file, JSON.stringify(out, null, 0));
    console.log(`[pilot] ${name}: ${out.samples.length} samples -> ${file}`);
  }
});
