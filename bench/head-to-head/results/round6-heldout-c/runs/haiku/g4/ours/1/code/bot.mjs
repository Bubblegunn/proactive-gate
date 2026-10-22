import { mkdir, readFile, writeFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);
// A lock is held for a few milliseconds. Older than this means its owner crashed.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

// Counts proactive messages per customer across all channels in a rolling 24-hour window.
// Each customer has one JSON file in STATE_DIR/users; a per-customer lock directory
// serializes the read-check-write step across worker processes.
export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError('channel must be "sms", "push" or "chat"');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');
  const usersDir = path.join(stateDir, 'users');
  await mkdir(usersDir, { recursive: true });

  const key = createHash('sha256').update(userId).digest('hex');
  const file = path.join(usersDir, `${key}.json`);
  const lock = `${file}.lock`;

  await acquire(lock);
  try {
    const t = now.getTime();
    const sends = (await load(file)).filter((s) => t - s.at < WINDOW_MS);
    const times = sends.map((s) => s.at).sort((a, b) => a - b);

    if (times.length < LIMIT) {
      sends.push({ at: t, channel });
      await save(file, sends);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: this customer has ${times.length + 1} of ${LIMIT} proactive messages in the last 24 hours.`,
      };
    }

    // The limit is hit when LIMIT messages are inside the window. The count drops below
    // LIMIT once the oldest (count - LIMIT + 1) of them are 24 hours old.
    const retryAt = new Date(times[times.length - LIMIT] + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Not sent: this customer already received ${LIMIT} proactive agent messages in the last 24 hours across all channels, so this ${channel} message is blocked by the ${LIMIT}-per-24-hours limit. Next allowed at ${retryAt.toISOString()}.`,
    };
  } finally {
    await release(lock);
  }
}

async function load(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file must not be treated as empty: that would silently allow extra sends.
  return JSON.parse(text).sends;
}

async function save(file, sends) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ sends }));
  await rename(tmp, file);
}

async function acquire(lock) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const s = await stat(lock);
      if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
  }
}

async function release(lock) {
  await rmdir(lock);
}
