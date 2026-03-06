import { writeFile } from 'node:fs/promises';

const outPath = process.env.ACTIVITY_PATH;
if (!outPath) throw new Error('ACTIVITY_PATH env missing');

const status = process.env.ACTIVITY_STATUS || 'working';
const task = process.env.ACTIVITY_TASK || 'tile-inference';
const step = process.env.ACTIVITY_STEP || '1/3';
const detail = process.env.ACTIVITY_DETAIL || 'computing walkable/seat/obstacle mask';
const intervalMs = Number(process.env.ACTIVITY_INTERVAL_MS || 20000);
const durationMs = Number(process.env.ACTIVITY_DURATION_MS || 60 * 60 * 1000);

const startedAt = Date.now();

async function tick() {
  const now = Date.now();
  const payload = { status, task, step, detail, startedAt, updatedAt: now };
  const txt = JSON.stringify(payload);
  // Serve as .js (JSON body) because some deployments reject .json via static handler.
  await writeFile(outPath, txt + "\n");
}

await tick();
const t = setInterval(() => {
  tick().catch(() => undefined);
  if (Date.now() - startedAt > durationMs) {
    clearInterval(t);
    // final mark as paused when duration ends
    const now = Date.now();
    const payload = { status: 'paused', task, step, detail: 'pulse ended (no further updates)', startedAt, updatedAt: now };
    writeFile(outPath, JSON.stringify(payload) + "\n").catch(() => undefined);
  }
}, intervalMs);
