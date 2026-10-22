import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

// Proactive agent messages allowed per customer in any rolling 24-hour window,
// counted across all channels together.
const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// A lock file older than this is assumed to belong to a crashed process.
// Holding the lock only covers a small read-modify-write, so this is far longer than needed.
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One state file per customer, so customers never wait on or affect each other.
// The file name is a hash of userId, which keeps arbitrary ids out of paths.
function stateFileFor(userId) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  const hash = createHash('sha256').update(userId).digest('hex');
  return join(dir, 'proactive-reserve', `${hash}.json`);
}

async function breakIfStale(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// open(..., 'wx') is an atomic create-if-absent, so only one process holds the lock at a time.
async function withLock(statePath, fn) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockPath);
      if (Date.now() > deadline) throw new Error(`timed out waiting for reserve lock ${lockPath}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

// A missing file means no sends yet. A corrupt file throws, so the send is refused
// rather than the count being silently reset to zero.
async function readSends(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return Array.isArray(parsed.sends) ? parsed.sends : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Write to a temp file and rename it, so a reader never sees a half-written state file.
async function writeSends(statePath, sends) {
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ sends }));
  await rename(tmpPath, statePath);
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

  const statePath = stateFileFor(userId);
  await mkdir(dirname(statePath), { recursive: true });
  const nowMs = now.getTime();

  return withLock(statePath, async () => {
    // A send counts while it is inside the window (windowStart, nowMs].
    const windowStart = nowMs - WINDOW_MS;
    const sends = (await readSends(statePath))
      .filter((send) => send.t > windowStart)
      .sort((a, b) => a.t - b.t);

    if (sends.length >= LIMIT) {
      // The count drops below LIMIT once (sends.length - LIMIT + 1) sends have left
      // the window. Those are the oldest ones, so the answer is the (sends.length - LIMIT)th
      // oldest send plus the window length.
      const retryAt = new Date(sends[sends.length - LIMIT].t + WINDOW_MS);
      return {
        allowed: false,
        retryAt,
        reason:
          `Held: this customer already received ${LIMIT} proactive agent messages in the last 24 hours ` +
          `across sms, push and chat, so no more are allowed in that period. ` +
          `The next one can be sent at ${retryAt.toISOString()}.`,
      };
    }

    sends.push({ t: nowMs, channel });
    await writeSends(statePath, sends);
    return {
      allowed: true,
      retryAt: null,
      reason: `Allowed: ${sends.length} of ${LIMIT} proactive agent messages used in the last 24 hours.`,
    };
  });
}
