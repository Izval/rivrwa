// render.mjs — steps film.html frame by frame in headless Chromium and pipes PNGs into ffmpeg, so the MP4 is
// exactly the preview (every pixel of the film is a function of t; see film.html).
//
//   cd video && npm install && npx playwright-core install chromium   # once
//   node render.mjs                      # → out/river-silent.mp4, 1920×1080, 30 fps (then ./mux.sh a|b for music)
//   node render.mjs --stills 5,30,60     # → out/still-5.png … for review, no video
//   node render.mjs --from 40 --to 60    # a slice, for quick checks
//
// Needs ffmpeg on PATH. Fonts load from Google Fonts, so the first run needs the network.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  fps: { type: "string", default: "30" }, from: { type: "string" }, to: { type: "string" },
  stills: { type: "string" }, out: { type: "string", default: "out/river-silent.mp4" },
} });
const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(here + "out", { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(here + "film.html").href + "?render");
await page.evaluate(() => window.FILM.ready);
await page.waitForTimeout(300);
const total = await page.evaluate(() => window.FILM.total);
const frame = page.locator("#frame");
const shot = async (t) => { await page.evaluate((t) => window.FILM.renderAt(t), t); return frame.screenshot({ type: "png" }); };

if (values.stills) {
  for (const t of values.stills.split(",").map(Number)) {
    await page.evaluate((t) => window.FILM.renderAt(t), t);
    await frame.screenshot({ path: `${here}out/still-${t}.png` });
    console.log(`out/still-${t}.png`);
  }
} else {
  const fps = Number(values.fps), t0 = Number(values.from ?? 0), t1 = Math.min(total, Number(values.to ?? total));
  const n = Math.round((t1 - t0) * fps);
  const out = values.out.startsWith("/") ? values.out : here + values.out;
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    const buf = await shot(t0 + i / fps);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % (fps * 10) === 0) console.log(`${(t0 + i / fps).toFixed(0)}s / ${t1.toFixed(0)}s  (${((Date.now() - started) / 1000).toFixed(0)}s elapsed)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`${out}: ${(t1 - t0).toFixed(1)} s at ${fps} fps`);
}
await browser.close();
