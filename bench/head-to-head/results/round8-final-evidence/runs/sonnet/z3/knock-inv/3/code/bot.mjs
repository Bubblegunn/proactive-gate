import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, link, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Morning briefing push: sent when the user wakes up (local time), with
// snooze, per-category switch, consent, OS permission and dismissal back-off.

const WAKE_HOUR = 7; // local hour the briefing window opens
const BRIEFING_END_HOUR = 11; // briefing is stale after this local hour
const DAY_END_HOUR = 22; // other card types: no push at night
const DISMISS_LIMIT = 3; // this many swipes inside the period pause push
const DISMISS_DAYS = 7;
const DAY_MS = 86_400_000;
const KEEP_CANDIDATES_MS = 60 * DAY_MS;

// ---------- time helpers ----------

const formatters = new Map();
function zoneParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

function zoneOffset(ms, tz) {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function localToUtc(y, m, d, hour, tz) {
  const guess = Date.UTC(y, m - 1, d, hour);
  const o1 = zoneOffset(guess, tz);
  let t = guess - o1;
  const o2 = zoneOffset(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

function windowFor(type) {
  return { start: WAKE_HOUR, end: type === 'briefing' ? BRIEFING_END_HOUR : DAY_END_HOUR };
}

// Earliest instant >= ms that lies inside the allowed local window.
function nextInWindow(ms, tz, win) {
  const p = zoneParts(ms, tz);
  if (p.hour >= win.start && p.hour < win.end) return ms;
  const dayShift = p.hour < win.start ? 0 : 1;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
  return localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), win.start, tz);
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}
const iso = (ms) => new Date(ms).toISOString();

// ---------- shared state (file based, safe across processes) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function withLock(dir, key, fn) {
  const path = join(dir, `${key}.lock`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await breakStaleLock(path);
      if (Date.now() > deadline) throw new Error('timed out waiting for state lock');
      await sleep(10 + Math.random() * 30);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}

async function breakStaleLock(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return; }
  const pid = Number.parseInt(text, 10);
  let stale;
  if (Number.isInteger(pid)) stale = !alive(pid);
  else {
    // empty file: owner may be between create and write
    const st = await stat(path).catch(() => null);
    stale = st && Date.now() - st.mtimeMs > 5000;
  }
  if (!stale) return;
  const moved = `${path}.stale-${randomBytes(6).toString('hex')}`;
  try { await rename(path, moved); } catch { return; }
  const movedText = await readFile(moved, 'utf8').catch(() => text);
  if (movedText !== text) await link(moved, path).catch(() => {}); // took a fresh lock by mistake: put it back
  await unlink(moved).catch(() => {});
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

// Run fn(state) under the per-user lock; fn mutates state through save().
async function withUserState(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = `user-${userKey(userId)}`;
  const file = join(dir, `${key}.json`);
  return withLock(dir, key, async () => {
    const state = await readState(file);
    state.candidates ??= {};
    state.pushDays ??= {};
    state.dismissals ??= {};
    return fn(state, () => writeState(file, state));
  });
}

// ---------- delivery ----------

function recentDismissals(state, type, nowMs) {
  return (state.dismissals[type] ?? []).filter((t) => t > nowMs - DISMISS_DAYS * DAY_MS).sort((a, b) => a - b);
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now);
  const type = candidate.type;

  return withUserState(user.id, async (state, save) => {
    for (const [id, c] of Object.entries(state.candidates)) {
      if (c.at < nowMs - KEEP_CANDIDATES_MS) delete state.candidates[id];
    }
    const prior = (state.candidates[candidate.id] ??= { push: false, inApp: false, at: nowMs });
    const result = (reason, resumeAt = null) => ({
      push: prior.push, inApp: prior.inApp, reason, resumeAt: resumeAt == null ? null : iso(resumeAt),
    });

    // 1. user switched this kind of notification off
    if (user.categories?.[type] === false) {
      return result(`You turned off ${type} notifications.`);
    }

    // 2. timezone and window
    const tz = user.timezone;
    let win;
    try {
      zoneParts(nowMs, tz);
      win = windowFor(type);
    } catch {
      return result('The time zone is unknown, so the send time cannot be chosen.');
    }

    // 3. snooze
    if (user.snoozedUntil != null) {
      const until = Date.parse(user.snoozedUntil);
      if (Number.isNaN(until)) return result('Notifications are snoozed, but the snooze end time is not readable.');
      if (until > nowMs) {
        return result(`Notifications are snoozed until ${iso(until)}.`, nextInWindow(until, tz, win));
      }
    }

    // 4. wake-up window
    const p = zoneParts(nowMs, tz);
    if (p.hour < win.start || p.hour >= win.end) {
      const reason = type === 'briefing'
        ? 'The morning briefing goes out in the morning, not at this hour.'
        : 'Not sending at night.';
      return result(reason, nextInWindow(nowMs, tz, win));
    }

    // 5. push gates (in-app item is still stored when these fail)
    let pushReason = null;
    let pushResume = null;
    const dayKey = `${p.year}-${p.month}-${p.day}`;

    if (!prior.push) {
      if (user.categories?.[type] !== true) {
        pushReason = `Push is off because ${type} notifications were never switched on in settings.`;
      } else if (user.notificationsPermitted === false) {
        pushReason = 'Notifications are blocked in the phone settings.';
      } else {
        let consents = null;
        try {
          consents = await consentStore.get(user.id);
        } catch {
          pushReason = 'Consent could not be checked right now, so no push was sent.';
        }
        if (!pushReason) {
          const c = consents ?? {};
          if (c.push === false || c[type] === false || !(c.push === true || c[type] === true)) {
            pushReason = 'There is no consent for push notifications.';
          }
        }
      }
      if (!pushReason) {
        const recent = recentDismissals(state, type, nowMs);
        if (recent.length >= DISMISS_LIMIT) {
          pushReason = `Push is paused because ${type} cards were dismissed ${recent.length} times this week.`;
          pushResume = nextInWindow(recent[recent.length - DISMISS_LIMIT] + DISMISS_DAYS * DAY_MS, tz, win);
        } else if (state.pushDays[type] === dayKey) {
          pushReason = `A ${type} push was already sent today.`;
          pushResume = nextInWindow(localToUtc(p.year, p.month, p.day + 1, win.start, tz), tz, win);
        }
      }
      if (!pushReason) {
        let accepted = false;
        try {
          accepted = (await transport.push(user, candidate)) === true;
        } catch {
          accepted = false;
        }
        if (accepted) {
          prior.push = true;
          state.pushDays[type] = dayKey;
          await save();
        } else {
          pushReason = 'The phone did not accept the push (for example no device token).';
        }
      }
    }

    // 6. in-app item (stored once per candidate)
    let inAppReason = null;
    if (!prior.inApp) {
      try {
        await transport.inApp(user, candidate);
        prior.inApp = true;
        await save();
      } catch {
        inAppReason = 'The in-app item could not be stored.';
      }
    }

    return result(pushReason ?? inAppReason, pushReason ? pushResume : null);
  });
}

export async function recordDismissal(userId, type, now) {
  const nowMs = toMs(now);
  await withUserState(userId, async (state, save) => {
    const list = recentDismissals(state, type, nowMs);
    list.push(nowMs);
    state.dismissals[type] = list;
    await save();
  });
}
