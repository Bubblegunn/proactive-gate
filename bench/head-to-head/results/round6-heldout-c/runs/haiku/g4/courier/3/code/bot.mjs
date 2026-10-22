import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const CHANNELS = new Set(['sms', 'push', 'chat']);
// Entries older than this can never fall inside a 24h window again, even if a
// caller passes a slightly older `now`, so they are safe to drop.
const KEEP_MS = 2 * WINDOW_MS;
// A lock directory older than this is assumed to belong to a crashed process.
// Lock hold time is a few milliseconds, so this is a very generous bound.
const LOCK_STALE_MS = 10_000;

/**
 * Decides whether one proactive agent message to `userId` may be sent now.
 * Limit: at most 5 messages in any 24-hour period, counted across all channels.
 * State lives in STATE_DIR and is shared by all worker processes on the host.
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat; got ${String(channel)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error('STATE_DIR environment variable is not set');
  }

  const root = path.resolve(stateDir);
  const usersDir = path.join(root, 'users');
  const locksDir = path.join(root, 'locks');
  await mkdir(usersDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  const key = createHash('sha256').update(userId).digest('hex');
  const file = path.join(usersDir, `${key}.json`);
  const lock = path.join(locksDir, `${key}.lock`);

  await acquire(lock);
  try {
    const nowMs = now.getTime();
    const sends = await loadSends(file);
    const kept = sends.filter((s) => s.at > nowMs - KEEP_MS);

    // Same rule for every caller: count sends with at > now - 24h. Sends dated
    // after `now` (from a worker whose clock is ahead) are counted too, which is
    // the conservative choice.
    const recent = kept
      .filter((s) => s.at > nowMs - WINDOW_MS)
      .sort((a, b) => a.at - b.at);
    const used = recent.length;

    if (used >= MAX_PER_WINDOW) {
      // Sends expire one by one, oldest first. To go from `used` back to
      // MAX_PER_WINDOW - 1 in the window, the (used - MAX_PER_WINDOW + 1) oldest
      // must expire. The last of them to expire is recent[used - MAX_PER_WINDOW].
      const blocking = recent[used - MAX_PER_WINDOW];
      const retryAt = new Date(blocking.at + WINDOW_MS);
      if (kept.length !== sends.length) {
        await saveSends(file, kept);
      }
      return {
        allowed: false,
        retryAt,
        reason: `Blocked: this customer already received ${MAX_PER_WINDOW} proactive agent messages in the last 24 hours across all channels (limit ${MAX_PER_WINDOW} per 24 hours, sms, push and chat combined), so this ${channel} message was not sent.`,
      };
    }

    kept.push({ at: nowMs, channel });
    await saveSends(file, kept);
    return {
      allowed: true,
      retryAt: null,
      reason: `Allowed: ${used + 1} of ${MAX_PER_WINDOW} proactive agent messages used in the last 24 hours across all channels.`,
    };
  } finally {
    await release(lock);
  }
}

async function loadSends(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file throws here. That fails closed: the message is not sent,
  // rather than being sent with an undercounted history.
  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error(`State file ${file} is not an array`);
  }
  return data;
}

async function saveSends(file, sends) {
  // Write to a temp file and rename, so a crash never leaves a half-written file.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(sends));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

// Lock = atomic mkdir. Only one process can create the directory at a time.
async function acquire(lock) {
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue;
    }
    await sleep(5 + Math.random() * 15);
  }
}

async function release(lock) {
  await rm(lock, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
