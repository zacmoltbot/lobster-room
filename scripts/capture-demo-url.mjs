import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const targetUrl = process.env.TARGET_URL || "https://zacbot.zeabur.app/lobster-room/";
const outDir = process.env.OUT_DIR || "docs/screenshots/demo-frames";
const frames = Number(process.env.FRAMES || 28);
const intervalMs = Number(process.env.INTERVAL_MS || 250);
const width = Number(process.env.WIDTH || 1280);
const height = Number(process.env.HEIGHT || 720);

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height } });

await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
// Give UI time to connect & show agents
await page.waitForTimeout(3000);

for (let i = 0; i < frames; i++) {
  const p = path.join(outDir, String(i).padStart(3, "0") + ".png");
  await page.screenshot({ path: p });
  await page.waitForTimeout(intervalMs);
}

await browser.close();
console.log(JSON.stringify({ outDir, frames, intervalMs, width, height, targetUrl }));
