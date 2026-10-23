import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 60000;
// Local days in different zones differ by at most 26 hours; keep a safe margin.
const KEEP_MS = 3 * 24 * 3600 * 1000;

const formatters = new Map();

function localDay(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'iso8601', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(lockPath) {
  const token = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lockPath);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // A crashed holder left the lock. Rename is atomic, so only one
        // contender removes it.
        const gone = `${lockPath}.stale-${token}`;
        try {
          await fs.rename(lockPath, gone);
          await fs.rm(gone, { recursive: true, force: true });
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for state lock');
    await sleep(Math.min(5 + attempt * 2, 50) + Math.random() * 10);
  }
}

async function release(lockPath) {
  await fs.rm(lockPath, { recursive: true, force: true });
}

// Calls in this process for the same user queue here; other processes
// are excluded by the lock directory.
const queues = new Map();

async function withUserLock(userId, fn) {
  const dir = stateDir();
  const key = crypto.createHash('sha256').update(userId).digest('hex');
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    await fs.mkdir(path.join(dir, 'locks'), { recursive: true });
    await fs.mkdir(path.join(dir, 'users'), { recursive: true });
    const lockPath = path.join(dir, 'locks', key);
    await acquire(lockPath);
    try {
      return await fn(path.join(dir, 'users', `${key}.json`));
    } finally {
      await release(lockPath);
    }
  });
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function readSent(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sent)) throw new Error(`corrupt state file ${file}`);
  return data.sent;
}

async function writeSent(file, sent) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ sent }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') return { allowed: false, rule: 'invalid-user' };
  if (!CHANNELS.has(channel)) return { allowed: false, rule: 'invalid-channel' };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { allowed: false, rule: 'invalid-time' };
  const nowMs = now.getTime();
  let today;
  try {
    today = localDay(nowMs, timeZone);
  } catch {
    return { allowed: false, rule: 'invalid-time-zone' };
  }

  return withUserLock(userId, async (file) => {
    const sent = await readSent(file);
    // Count in the caller's current time zone, so a zone change cannot hide earlier sends.
    const count = sent.filter((t) => localDay(t.ms, timeZone) === today).length;
    if (count >= DAILY_CAP) return { allowed: false, rule: 'daily-cap' };
    const kept = sent.filter((t) => t.ms > nowMs - KEEP_MS);
    kept.push({ ms: nowMs, channel });
    await writeSent(file, kept);
    return { allowed: true, rule: '' };
  });
}
