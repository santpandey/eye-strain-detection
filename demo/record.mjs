// Record the 40 s blinkwell demo: Playwright captures the page as webm.
// Convert:  demo/tools/ffmpeg.exe -i demo/out/page*.webm -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart demo/blinkwell-demo-40s.mp4
//   node demo/record.mjs shots    → screenshot every scene (verification)
//   node demo/record.mjs          → record demo/demo.webm (~40 s)
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = "file:///" + path.join(here, "demo.html").replaceAll("\\", "/");
const shots = process.argv[2] === "shots";
const browser = await chromium.launch();

if (shots) {
  mkdirSync(path.join(here, "shots"), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (let s = 1; s <= 9; s++) {
    await page.goto(`${url}?still=${s}`);
    await page.waitForTimeout(5200); // let the scene's own timers play out
    await page.screenshot({ path: path.join(here, "shots", `s${s}.png`) });
    console.log("s" + s);
  }
  await browser.close();
  process.exit(0);
}

mkdirSync(path.join(here, "out"), { recursive: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: path.join(here, "out"), size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto(url);
await page.waitForTimeout(48_400); // scenes end at 48.0 s + small tail
await ctx.close(); // finalises the .webm
await browser.close();
console.log("done → demo/out/");
