import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DAILY_CAP = 2;
const CHANNELS = new Set(['sms', 'email', 'push']);
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const KEEP_MS = 7 * 24 * 3600 * 1000;

const formatters = new Map();

// Calendar date (YYYY-MM-DD) of an instant in an IANA time zone.
function localDay(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f.format(ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(lockPath) {
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(token);
      await fh.close();
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Lock left behind by a crashed process: remove it once it is old.
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const observed = await fs.readFile(lockPath, 'utf8');
        const trash = `${lockPath}.stale-${randomBytes(6).toString('hex')}`;
        await fs.rename(lockPath, trash);
        const moved = await fs.readFile(trash, 'utf8').catch(() => null);
        if (moved === observed) {
          await fs.unlink(trash).catch(() => {});
        } else {
          // Took a fresh lock by mistake: put it back if the path is free.
          await fs.link(trash, lockPath).catch(() => {});
          await fs.unlink(trash).catch(() => {});
        }
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue; // lock released meanwhile
      throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(`reserve: timed out waiting for lock ${lockPath}`);
    }
    await sleep(Math.min(5 + attempt * 2, 50) + Math.random() * 10);
  }
}

async function releaseLock(lockPath, token) {
  try {
    if ((await fs.readFile(lockPath, 'utf8')) === token) await fs.unlink(lockPath);
  } catch {
    // already gone
  }
}

async function readState(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data.sent) ? data.sent : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err; // corrupt state: fail closed, nothing is sent
  }
}

async function writeState(file, userId, sent) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ userId, sent }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  try {
    const dir = await fs.open(path.dirname(file), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // directory fsync not supported here
  }
}

export async function reserve({ userId, timeZone, channel, now }) {
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!CHANNELS.has(channel)) throw new TypeError(`unknown channel: ${channel}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  if (typeof timeZone !== 'string') throw new TypeError('timeZone must be an IANA name');
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');

  const nowMs = now.getTime();
  const today = localDay(nowMs, timeZone); // throws RangeError on a bad zone

  const dir = path.resolve(stateDir);
  await fs.mkdir(dir, { recursive: true });
  const name = createHash('sha256').update(userId).digest('hex');
  const file = path.join(dir, `${name}.json`);
  const lockPath = path.join(dir, `${name}.lock`);

  const token = await acquireLock(lockPath);
  try {
    const sent = await readState(file);
    // Count by the local day in the zone given now, so a zone change is handled.
    const count = sent.filter((e) => localDay(e.at, timeZone) === today).length;
    if (count >= DAILY_CAP) return { allowed: false, rule: 'daily-cap' };

    const newest = Math.max(nowMs, ...sent.map((e) => e.at));
    const kept = sent.filter((e) => e.at >= newest - KEEP_MS);
    kept.push({ at: nowMs, channel });
    await writeState(file, userId, kept);
    return { allowed: true, rule: '' };
  } finally {
    await releaseLock(lockPath, token);
  }
}
