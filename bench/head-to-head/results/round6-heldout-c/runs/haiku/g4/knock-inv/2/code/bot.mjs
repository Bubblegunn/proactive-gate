// Per-customer cap on proactive agent messages: at most 5 in any rolling 24 hours,
// across sms, push and chat together. State lives in STATE_DIR so that separate
// worker processes on one server share one count per customer.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);
const LOCK_STALE_MS = 10_000; // a lock older than this came from a crashed process
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 5;

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
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error('STATE_DIR is not set');
  }
  await mkdir(stateDir, { recursive: true });

  // One file and one lock per customer, so customers never wait on each other.
  const base = path.join(stateDir, createHash('sha256').update(userId).digest('hex'));
  const file = `${base}.json`;
  const lock = `${base}.lock`;
  const nowMs = now.getTime();

  await acquireLock(lock);
  try {
    const active = (await loadSends(file))
      .filter((s) => nowMs - s.t < WINDOW_MS)
      .sort((a, b) => a.t - b.t);

    if (active.length < LIMIT) {
      active.push({ t: nowMs, channel });
      await saveSends(file, active);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${active.length} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // Blocked. The count drops below LIMIT once the oldest (active.length - LIMIT + 1)
    // sends have left the window; the last of those is at index active.length - LIMIT.
    const retryMs = active[active.length - LIMIT].t + WINDOW_MS;
    const retryAt = new Date(retryMs);
    return {
      allowed: false,
      retryAt,
      reason: `Blocked: this customer already received ${LIMIT} proactive agent messages in the last 24 hours (across sms, push and chat). The next one is allowed at ${retryAt.toISOString()}.`,
    };
  } finally {
    await releaseLock(lock);
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
  // A corrupt file must not reset the count, so this throws and the send is not made.
  const sends = JSON.parse(text);
  if (!Array.isArray(sends)) {
    throw new Error(`corrupt rate-limit state file: ${file}`);
  }
  return sends;
}

async function saveSends(file, sends) {
  // Write to a temp file and rename, so a reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(sends));
  await rename(tmp, file);
}

async function acquireLock(lock) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // mkdir is atomic: exactly one process succeeds.
      await mkdir(lock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lock);
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // released meanwhile: retry at once
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for rate-limit lock: ${lock}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function releaseLock(lock) {
  await rmdir(lock);
}
