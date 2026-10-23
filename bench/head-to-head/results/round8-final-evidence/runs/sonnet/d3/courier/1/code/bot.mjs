import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const KEEP_MS = 4 * 24 * 3600 * 1000; // enough to cover every time zone's "today"
const LOCK_WAIT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-process queue per user, so calls inside one worker do not fight over the file lock.
const queues = new Map();

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function tryBreakStale(lockPath) {
  let text;
  let st;
  try {
    st = await fs.stat(lockPath);
    text = await fs.readFile(lockPath, 'utf8');
  } catch {
    return; // gone already
  }
  const pid = Number.parseInt(text, 10);
  let stale;
  if (Number.isInteger(pid) && pid > 0) stale = !pidAlive(pid);
  else stale = Date.now() - st.mtimeMs > 5000; // owner never finished writing its pid
  if (!stale) return;
  const grave = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, grave);
  } catch {
    return;
  }
  try {
    const moved = await fs.readFile(grave, 'utf8');
    if (moved !== text) {
      // We moved a lock that someone else had just taken. Put it back if the path is free.
      try {
        await fs.link(grave, lockPath);
      } catch {}
    }
  } catch {}
  await fs.rm(grave, { force: true });
}

async function withFileLock(lockPath, fn) {
  const started = Date.now();
  let delay = 2;
  for (;;) {
    let fh;
    try {
      fh = await fs.open(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await tryBreakStale(lockPath);
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`timed out waiting for lock ${lockPath}`);
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 50);
      continue;
    }
    try {
      await fh.writeFile(String(process.pid));
    } finally {
      await fh.close();
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }
}

function localDay(date, timeZone) {
  // en-CA gives YYYY-MM-DD. Throws RangeError for an unknown time zone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function readSent(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const data = JSON.parse(raw); // corrupt state throws: never guess and risk a third message
  if (!Array.isArray(data.sent)) throw new Error(`bad state file ${file}`);
  return data.sent;
}

async function writeSent(file, sent) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ sent }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

async function decide({ userId, timeZone, channel, now }) {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');
  const dir = path.join(stateDir, 'marketing-cap');
  await fs.mkdir(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(userId).digest('hex');
  const file = path.join(dir, `${key}.json`);
  const nowMs = now.getTime();
  const today = localDay(now, timeZone);

  return withFileLock(`${file}.lock`, async () => {
    const sent = await readSent(file);
    const todays = sent.filter((m) => localDay(new Date(m.t), timeZone) === today);
    if (todays.length >= DAILY_CAP) return { allowed: false, rule: 'daily-cap' };
    const kept = sent.filter((m) => nowMs - m.t < KEEP_MS && m.t - nowMs < KEEP_MS);
    kept.push({ t: nowMs, c: channel });
    await writeSent(file, kept);
    return { allowed: true, rule: '' };
  });
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (typeof timeZone !== 'string') throw new TypeError('timeZone must be a string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  localDay(now, timeZone); // validate zone before touching state

  const prev = queues.get(userId) ?? Promise.resolve();
  const run = prev.then(() => decide({ userId, timeZone, channel, now }));
  const tail = run.catch(() => {});
  queues.set(userId, tail);
  tail.then(() => {
    if (queues.get(userId) === tail) queues.delete(userId);
  });
  return run;
}
