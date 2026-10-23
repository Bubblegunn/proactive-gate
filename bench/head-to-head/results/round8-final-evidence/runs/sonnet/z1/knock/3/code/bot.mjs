// Notification gate. Every rule fails closed: if anything is unknown or broken, nothing is sent.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const MIN_GAP_ANY = 2 * HOUR; // between two notifications of any type
const MIN_GAP_SAME_TYPE = 20 * HOUR; // also protects travellers whose local day changed
const MAX_PER_LOCAL_DAY = 3; // all types together
const DISMISSAL_MEMORY = 60 * DAY;
const BACKOFF_DAYS = [1, 3, 7, 14, 30]; // pause after the 1st, 2nd, ... dismissal
const LOCK_STALE_MS = 15000;
const KEEP_DELIVERED_MS = 3 * DAY;
const KEEP_IDS = 500;

const no = (reason) => ({ send: false, reason });

// ---------- time zones ----------
const fmtCache = new Map();
function validZone(z) {
  if (typeof z !== 'string' || !z || z.toUpperCase() === 'UTC' || z === 'Etc/UTC' || z === 'GMT') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}
function localParts(ms, zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
// The phone's last reported zone is the freshest signal (the user may have travelled).
function pickZone(user) {
  return validZone(user.deviceTimezone) || validZone(user.timezone);
}

// ---------- storage ----------
function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}
function userFile(dir, userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, `u-${h}.json`);
}
async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { optOut: {}, dismissals: {}, delivered: [] };
    throw e; // unreadable state: caller fails closed
  }
}
async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 20000;
  for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.unlink(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error('lock timeout');
      await new Promise((r) => setTimeout(r, wait + Math.random() * wait));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}
async function mutate(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const file = userFile(dir, userId);
  return withLock(file, async () => {
    const state = await readState(file);
    state.optOut ||= {};
    state.dismissals ||= {};
    state.delivered ||= [];
    const result = await fn(state);
    if (result.write) await writeState(file, state);
    return result.value;
  });
}

// ---------- public API ----------
export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (flags?.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user?.id || !candidate?.id || !candidate?.type) return no('The request is missing a user or notification.');
    const t = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(t)) return no('The current time is not valid.');

    // Proactive nudges need an explicit "yes"; missing or empty consent means no.
    if (user.consents?.marketing !== true) return no('The user has not agreed to receive these notifications.');

    const zone = pickZone(user);
    if (!zone) return no('The user\'s time zone is unknown, so quiet hours cannot be checked.');
    const here = localParts(t, zone);
    if (here.hour < WINDOW_START_HOUR || here.hour >= WINDOW_END_HOUR) {
      return no('It is outside the user\'s allowed hours (09:00 to 20:00 local time).');
    }

    const type = String(candidate.type);
    return await mutate(user.id, async (s) => {
      if (s.optOut[type]) return { value: no('The user switched this notification type off.') };

      if (s.delivered.some((d) => d.id === candidate.id)) {
        return { value: no('This notification was already delivered.') };
      }

      const dis = (s.dismissals[type] || []).filter((x) => t - x < DISMISSAL_MEMORY);
      if (dis.length) {
        const last = Math.max(...dis);
        const days = BACKOFF_DAYS[Math.min(dis.length, BACKOFF_DAYS.length) - 1];
        if (t < last + days * DAY) return { value: no('The user recently dismissed this type, so it is paused for a while.') };
      }

      const recent = s.delivered.filter((d) => t - d.at < KEEP_DELIVERED_MS);
      const sameType = recent.filter((d) => d.type === type);
      for (const d of sameType) {
        if (localParts(d.at, zone).day === here.day) return { value: no('This type was already sent today.') };
        if (t - d.at < MIN_GAP_SAME_TYPE && t >= d.at) return { value: no('This type was sent too recently.') };
      }
      if (recent.some((d) => t >= d.at && t - d.at < MIN_GAP_ANY)) {
        return { value: no('Another notification was sent a short while ago.') };
      }
      if (recent.filter((d) => localParts(d.at, zone).day === here.day).length >= MAX_PER_LOCAL_DAY) {
        return { value: no('The daily limit of notifications has been reached.') };
      }

      s.delivered = [...recent, { id: candidate.id, type, at: t }].slice(-KEEP_IDS);
      s.dismissals[type] = dis;
      return { write: true, value: { send: true, reason: null } };
    });
  } catch (e) {
    return no(`The notification was held back because the check failed (${e.message}).`);
  }
}

export async function recordDismissal(userId, type, now) {
  const t = now instanceof Date ? now.getTime() : Date.now();
  await mutate(userId, async (s) => {
    const list = (s.dismissals[type] || []).filter((x) => t - x < DISMISSAL_MEMORY);
    list.push(t);
    s.dismissals[type] = list.slice(-20);
    return { write: true };
  });
}

export async function optOut(userId, type) {
  await mutate(userId, async (s) => {
    s.optOut[type] = true;
    return { write: true };
  });
}
