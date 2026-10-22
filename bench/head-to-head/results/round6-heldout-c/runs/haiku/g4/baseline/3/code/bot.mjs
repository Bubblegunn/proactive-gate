// Proactive message limiter shared by several worker processes.
//
// Rule: one customer may receive at most LIMIT proactive agent messages in any
// rolling 24-hour window, counted across all channels together.
//
// State lives in STATE_DIR (the only thing the workers share):
//   STATE_DIR/users/<sha256(userId)>.json   sent-message log for one customer
//   STATE_DIR/locks/<sha256(userId)>.lock   mkdir-based lock for that customer
// Each customer has its own files, so customers never block or count each other.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// The critical section takes milliseconds. A lock older than this is assumed
// to belong to a process that crashed while holding it.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keyFor(userId) {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

async function withLock(lockFile, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockFile);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockFile).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // holder released it between our mkdir and stat
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for limiter lock ${lockFile}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockFile).catch(() => {});
  }
}

async function readSent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file makes us fail closed: the send is refused, not counted as free.
  const parsed = JSON.parse(text);
  return parsed.sent;
}

async function writeSent(file, sent) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ sent }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file); // atomic replace: readers see old or new, never partial
}

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError('channel must be "sms", "push" or "chat"');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR environment variable is not set');

  const nowMs = now.getTime();
  const key = keyFor(userId);
  await mkdir(join(root, 'users'), { recursive: true });
  await mkdir(join(root, 'locks'), { recursive: true });

  const file = join(root, 'users', `${key}.json`);
  const lockFile = join(root, 'locks', `${key}.lock`);

  return withLock(lockFile, async () => {
    // Sliding window: an entry counts while it is strictly newer than now - 24h.
    const sent = (await readSent(file))
      .filter((entry) => entry.at > nowMs - WINDOW_MS)
      .sort((a, b) => a.at - b.at);

    if (sent.length < LIMIT) {
      sent.push({ at: nowMs, channel });
      await writeSent(file, sent);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${sent.length} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // Blocked. Sends drop out of the window one by one; a new send is possible
    // once only LIMIT - 1 entries remain, i.e. once the entry at index
    // (length - LIMIT) has aged past 24 hours.
    const retryAt = new Date(sent[sent.length - LIMIT].at + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason:
        `Blocked: this customer already received ${LIMIT} proactive messages in the last 24 hours ` +
        `(the limit is ${LIMIT} across sms, push and chat combined). ` +
        `The next message can be sent after ${retryAt.toISOString()}.`,
    };
  });
}
