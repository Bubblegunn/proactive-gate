import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);
// A lock older than this belongs to a process that died while holding it.
const LOCK_STALE_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cross-process lock: mkdir is atomic, so only one worker can create the directory.
async function acquire(lockPath) {
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
      }
      await sleep(5 + Math.random() * 15);
    }
  }
}

// A missing record means no sends yet. A corrupt record throws, so nothing is
// silently reset and the caller fails before it sends.
async function readStamps(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data) || !data.every((t) => Number.isFinite(t))) {
    throw new Error(`corrupt record: ${file}`);
  }
  return data;
}

// Temp file, fsync, then rename, so a reader never sees a half-written record.
async function writeStamps(file, stamps) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(stamps));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError('channel must be "sms", "push" or "chat"');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');

  const recordsDir = path.join(root, 'records');
  const locksDir = path.join(root, 'locks');
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.mkdir(locksDir, { recursive: true });

  // Hash the id so any string is a safe file name. Each customer has its own
  // record and lock, so one customer never waits on or counts against another.
  const key = createHash('sha256').update(userId).digest('hex');
  const file = path.join(recordsDir, `${key}.json`);
  const lock = path.join(locksDir, `${key}.lock`);

  const t = now.getTime();
  await acquire(lock);
  try {
    // Rolling window: a send counts while its timestamp is strictly after now - 24h.
    const stamps = (await readStamps(file))
      .filter((s) => s > t - WINDOW_MS)
      .sort((a, b) => a - b);

    if (stamps.length < LIMIT) {
      stamps.push(t);
      stamps.sort((a, b) => a - b);
      await writeStamps(file, stamps);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${stamps.length} of ${LIMIT} proactive messages used in the last 24 hours across all channels.`,
      };
    }

    // Count drops below LIMIT once the LIMIT-th most recent send leaves the window.
    const retryAt = new Date(stamps[stamps.length - LIMIT] + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Blocked: this customer already received ${LIMIT} proactive agent messages in the last 24 hours across sms, push and chat together, which is the limit of ${LIMIT} per rolling 24 hours. The next one can go at ${retryAt.toISOString()}.`,
    };
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
