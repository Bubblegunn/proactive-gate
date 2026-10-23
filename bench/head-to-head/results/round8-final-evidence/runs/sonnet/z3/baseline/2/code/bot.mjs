import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Morning briefing delivery policy.
const WINDOW_START_MIN = 7 * 60; // earliest local time for any push
const BRIEFING_END_MIN = 11 * 60; // a briefing is stale after this local time
const OTHER_END_MIN = 22 * 60; // quiet hours start for other card types
const DISMISS_LIMIT = 3; // this many dismissals ...
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000; // ... within this time pause push for the type
const MAX_DISMISSALS_KEPT = 20;
const MAX_SENT_KEPT = 200;
const LOCK_WAIT_MS = 30000;
const LOCK_STALE_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) throw new TypeError('now is not a valid time');
  return ms;
}

// ---------- time zone helpers ----------

const formatters = new Map();
function partsAt(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
const localAsUtc = (ms, tz) => {
  const p = partsAt(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
};
// UTC instant at which the wall clock in tz shows the given local date and minute of day.
function zonedToUtc(y, m, d, minuteOfDay, tz) {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const first = guess - (localAsUtc(guess, tz) - guess);
  return guess - (localAsUtc(first, tz) - first);
}
function dayKey(ms, tz) {
  const p = partsAt(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
// First allowed instant at or after ms inside [startMin, endMin) local time.
function nextAllowed(ms, tz, startMin, endMin) {
  const p = partsAt(ms, tz);
  const min = p.hour * 60 + p.minute;
  if (min >= startMin && min < endMin) return ms;
  const dayOffset = min < startMin ? 0 : 1;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), startMin, tz);
}
function nextDayStart(ms, tz) {
  const p = partsAt(ms, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), WINDOW_START_MIN, tz);
}

// ---------- shared state (one file per user, guarded by a lock directory) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}
const userKey = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 32);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function lockIsStale(lockDir) {
  try {
    const st = await fs.stat(lockDir);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(await fs.readFile(path.join(lockDir, 'pid'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
  } catch {
    return false; // vanished, or owner has not written its pid yet
  }
}

async function withUserLock(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `${userKey(userId)}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, 'pid'), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await lockIsStale(lockDir)) {
        const grave = `${lockDir}.dead-${process.pid}-${Date.now()}`;
        try { await fs.rename(lockDir, grave); await fs.rm(grave, { recursive: true, force: true }); } catch { /* another worker won */ }
        continue;
      }
      if (Date.now() > deadline) {
        const err = new Error('could not get the user lock');
        err.code = 'LOCK_TIMEOUT';
        throw err;
      }
      await sleep(10 + Math.random() * 30);
    }
  }
  try {
    return await fn(path.join(dir, `${userKey(userId)}.json`));
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function loadState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { dismissals: s.dismissals ?? {}, sent: s.sent ?? [], lastDay: s.lastDay ?? {} };
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return { dismissals: {}, sent: [], lastDay: {} };
    throw e;
  }
}
async function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const ms = toMs(now);
  await withUserLock(userId, async (file) => {
    const state = await loadState(file);
    const list = [...(state.dismissals[type] ?? []), ms].sort((a, b) => a - b);
    state.dismissals[type] = list.slice(-MAX_DISMISSALS_KEPT);
    await saveState(file, state);
  });
}

const result = (push, inApp, reason, resumeAt) => ({
  push, inApp, reason: reason ?? null, resumeAt: resumeAt == null ? null : new Date(resumeAt).toISOString(),
});

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now);
  const type = candidate.type;
  const label = type === 'briefing' ? 'morning briefing' : `${type}`;

  if (user.categories?.[type] === false) {
    return result(false, false, `The user turned off ${label} notifications.`, null);
  }

  let consents;
  try {
    consents = (await consentStore.get(user.id)) ?? {};
  } catch {
    return result(false, false, 'Consent could not be checked right now, so nothing was sent.', null);
  }
  if (consents[type] === false || consents.notifications === false) {
    return result(false, false, `The user has not consented to ${label} notifications.`, null);
  }

  let tz = user.timezone;
  try { partsAt(nowMs, tz); } catch { tz = null; }

  try {
    return await withUserLock(user.id, (file) => attempt(file));
  } catch (e) {
    if (e.code === 'LOCK_TIMEOUT') return result(false, false, 'Another worker is busy with this user; try again shortly.', null);
    throw e;
  }

  async function attempt(file) {
    const state = await loadState(file);
    const prior = state.sent.find((s) => s.id === candidate.id && s.type === type);
    let inApp = prior?.inApp === true;
    let pushed = prior?.push === true;
    const today = tz ? dayKey(nowMs, tz) : null;

    // Only one briefing per local day; a second candidate that day is dropped.
    if (type === 'briefing' && tz && !prior) {
      const last = state.lastDay[type];
      if (last && last.day === today && last.id !== candidate.id) {
        return result(false, false, 'A morning briefing was already delivered today.', nextDayStart(nowMs, tz));
      }
    }

    // Reasons the push cannot go out. `until` is when it could, or null if unknown.
    const blockers = [];
    if (!pushed) {
      if (user.categories?.[type] !== true) blockers.push({ reason: `The user has not chosen to receive ${label} push notifications.`, until: null });
      if (user.notificationsPermitted === false) blockers.push({ reason: 'Notifications are switched off in the phone settings.', until: null });
      if (consents.push === false) blockers.push({ reason: 'The user has not consented to push notifications.', until: null });
      const snooze = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
      if (Number.isFinite(snooze) && snooze > nowMs) blockers.push({ reason: `${label[0].toUpperCase()}${label.slice(1)} is snoozed.`, until: snooze });
      const dismissed = (state.dismissals[type] ?? []).filter((t) => t > nowMs - DISMISS_WINDOW_MS && t <= nowMs).sort((a, b) => b - a);
      if (dismissed.length >= DISMISS_LIMIT) {
        blockers.push({ reason: `The user dismissed the last ${DISMISS_LIMIT} ${type} cards, so push is paused for a while.`, until: dismissed[DISMISS_LIMIT - 1] + DISMISS_WINDOW_MS });
      }
      if (!tz) {
        blockers.push({ reason: 'The time zone is unknown, so the local time cannot be checked.', until: null });
      } else {
        const endMin = type === 'briefing' ? BRIEFING_END_MIN : OTHER_END_MIN;
        const ok = nextAllowed(nowMs, tz, WINDOW_START_MIN, endMin);
        if (ok !== nowMs) {
          blockers.push({
            reason: type === 'briefing' ? 'It is not morning for the user right now.' : 'It is quiet hours for the user right now.',
            until: ok,
          });
        }
      }
    }

    let reason = null;
    let resumeAt = null;
    if (blockers.length) {
      reason = blockers[0].reason;
      if (blockers.every((b) => b.until != null)) {
        const endMin = type === 'briefing' ? BRIEFING_END_MIN : OTHER_END_MIN;
        resumeAt = nextAllowed(Math.max(...blockers.map((b) => b.until)), tz, WINDOW_START_MIN, endMin);
      }
    } else if (!pushed) {
      try {
        pushed = (await transport.push(user, candidate)) === true;
      } catch {
        pushed = false;
      }
      if (!pushed) reason = 'The phone did not accept the push (for example no device token).';
    }

    if (!inApp) {
      try {
        await transport.inApp(user, candidate);
        inApp = true;
      } catch {
        inApp = false;
        reason ??= 'The in-app item could not be stored.';
      }
    }

    if (pushed || inApp) {
      state.sent = state.sent.filter((s) => !(s.id === candidate.id && s.type === type));
      state.sent.push({ id: candidate.id, type, push: pushed, inApp, at: nowMs });
      state.sent = state.sent.slice(-MAX_SENT_KEPT);
      if (tz) state.lastDay[type] = { day: today, id: candidate.id };
      await saveState(file, state);
    }
    return result(pushed, inApp, reason, resumeAt);
  }
}
