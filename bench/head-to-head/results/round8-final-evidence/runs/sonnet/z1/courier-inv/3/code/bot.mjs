// Gate for proactive notifications (daily check-in and other types).
// State is one JSON file per user in STATE_DIR, guarded by a lock directory,
// so several worker processes on one machine can share it safely.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const SEND_FROM_HOUR = 9; // local time, inclusive
const SEND_UNTIL_HOUR = 20; // local time, exclusive
const MIN_GAP_SAME_TYPE = 20 * HOUR;
const MAX_PROACTIVE_PER_LOCAL_DAY = 2; // all types together
const DISMISSAL_WINDOW = 30 * DAY;
const KEEP_CANDIDATE_IDS = 100;
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;

// After N dismissals of a type in the window, wait this long after the last one.
function dismissalPause(count) {
  if (count <= 0) return 0;
  if (count === 1) return 2 * DAY;
  if (count === 2) return 7 * DAY;
  return DISMISSAL_WINDOW;
}

function stateDir() {
  return (
    process.env.STATE_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '.state')
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex');
}

async function withUserLock(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = userKey(userId);
  const lockPath = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockPath); // atomic: only one process succeeds
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Holder probably crashed. Rename is atomic, so only one process wins the takeover.
          const trash = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
          try {
            await fs.rename(lockPath, trash);
            await fs.rm(trash, { recursive: true, force: true });
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('timeout waiting for state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(path.join(dir, `${key}.json`));
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function load(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      optedOut: s.optedOut ?? {},
      dismissals: s.dismissals ?? {},
      sent: s.sent ?? [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, dismissals: {}, sent: [] };
    throw e;
  }
}

async function save(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

// The device zone is where the user is now. The saved zone is used when the
// device zone is missing. "UTC" as saved zone is a placeholder, not a real answer.
function resolveZone(user) {
  const device = validZone(user?.deviceTimezone);
  if (device) return device;
  const saved = validZone(user?.timezone);
  if (saved && saved.toUpperCase() !== 'UTC') return saved;
  return null;
}

function localParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  // Fail closed: only an explicit true allows proactive sends.
  if (flags?.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
  if (!user?.id || !candidate?.id || !candidate?.type) return no('The request is missing a user or candidate.');
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) return no('The current time is not valid.');

  const type = String(candidate.type);

  // Consent: a proactive nudge needs an explicit yes. Missing or empty means no.
  if (user.consents?.marketing !== true) return no('The user has not agreed to receive these notifications.');

  const zone = resolveZone(user);
  if (!zone) return no("The user's time zone is unknown, so a safe time to send cannot be checked.");
  const { day, hour } = localParts(nowMs, zone);
  if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) {
    return no("It is outside the user's allowed hours (9:00 to 20:00 local time).");
  }

  return withUserLock(user.id, async (file) => {
    const state = await load(file);

    if (state.optedOut[type]) return no('The user switched this notification type off.');

    if (state.sent.some((s) => s.id === candidate.id)) return no('This notification was already delivered.');

    const recent = (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISSAL_WINDOW);
    if (recent.length) {
      const last = Math.max(...recent);
      if (nowMs < last + dismissalPause(recent.length)) {
        return no('The user dismissed this type recently, so it is paused for now.');
      }
    }

    const todays = state.sent.filter((s) => localParts(s.at, zone).day === day);
    if (todays.some((s) => s.type === type)) return no('This type was already delivered today.');
    if (todays.length >= MAX_PROACTIVE_PER_LOCAL_DAY) return no('The daily limit of notifications was reached.');
    const lastSame = Math.max(0, ...state.sent.filter((s) => s.type === type).map((s) => s.at));
    if (nowMs - lastSame < MIN_GAP_SAME_TYPE) return no('This type was delivered too recently.');

    state.sent.push({ id: candidate.id, type, at: nowMs });
    state.sent = state.sent.slice(-KEEP_CANDIDATE_IDS);
    await save(file, state);
    return { send: true, reason: null };
  });
}

export async function recordDismissal(userId, type, now) {
  const at = now instanceof Date ? now.getTime() : Date.now();
  await withUserLock(userId, async (file) => {
    const state = await load(file);
    const list = (state.dismissals[type] ?? []).filter((t) => at - t < DISMISSAL_WINDOW);
    list.push(at);
    state.dismissals[type] = list;
    await save(file, state);
  });
}

export async function optOut(userId, type) {
  await withUserLock(userId, async (file) => {
    const state = await load(file);
    state.optedOut[type] = true;
    await save(file, state);
  });
}
