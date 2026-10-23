import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

const WAKE_HOUR = 7; // push allowed from 07:00 local time
const SLEEP_HOUR = 22; // no push from 22:00 local time
const DISMISS_LIMIT = 3; // this many swipes of one type inside the window pauses its push
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000;
const KEEP_DELIVERED = 100;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 15000;

// ---------- time helpers ----------

const formatters = new Map();

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid time: ${String(value)}`);
  return ms;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    zoneFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function zoneFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of zoneFormatter(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return p; // year, month, day, hour, minute, second
}

function zoneOffset(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function localToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffset(guess, tz);
  let t = guess - off1;
  const off2 = zoneOffset(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

function dayKey(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function isQuiet(ms, tz) {
  const h = localParts(ms, tz).hour;
  return h < WAKE_HOUR || h >= SLEEP_HOUR;
}

// first WAKE_HOUR:00 local strictly after ms
function nextWake(ms, tz) {
  const p = localParts(ms, tz);
  for (let k = 0; k < 3; k++) {
    const t = localToUtc(p.year, p.month, p.day + k, WAKE_HOUR, 0, tz);
    if (t > ms) return t;
  }
  return ms + 24 * 3600 * 1000;
}

// 07:00 local on the day after the local day of ms
function wakeNextDay(ms, tz) {
  const p = localParts(ms, tz);
  return localToUtc(p.year, p.month, p.day + 1, WAKE_HOUR, 0, tz);
}

const iso = (ms) => new Date(ms).toISOString();

// ---------- shared state (one JSON file per user, guarded by a lock file) ----------

function stateDir() {
  return process.env.STATE_DIR || path.join(process.cwd(), '.state');
}

function userFile(userId) {
  return path.join(stateDir(), `user-${createHash('sha256').update(String(userId)).digest('hex').slice(0, 32)}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(lockPath) {
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(token);
      await fh.close();
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const seen = await readFile(lockPath, 'utf8').catch(() => null);
        const st2 = await stat(lockPath).catch(() => null);
        if (st2 && st2.mtimeMs === st.mtimeMs && seen !== null) await unlink(lockPath).catch(() => {});
        continue;
      }
    } catch {
      continue; // lock vanished, try again
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for state lock');
    await sleep(5 + Math.random() * 25);
  }
}

async function release(lockPath, token) {
  const current = await readFile(lockPath, 'utf8').catch(() => null);
  if (current === token) await unlink(lockPath).catch(() => {});
}

async function readState(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch {
    // missing or unreadable: start empty
  }
  return {};
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

async function withUserState(userId, fn) {
  await mkdir(stateDir(), { recursive: true });
  const file = userFile(userId);
  const lockPath = `${file}.lock`;
  const token = await acquire(lockPath);
  try {
    const state = await readState(file);
    state.delivered ??= {};
    state.pushDay ??= {};
    state.dismissals ??= {};
    return await fn(state, () => writeState(file, state));
  } finally {
    await release(lockPath, token);
  }
}

function dismissalPause(state, type, nowMs) {
  const recent = (state.dismissals[type] || []).filter((t) => t > nowMs - DISMISS_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length < DISMISS_LIMIT) return null;
  return recent[recent.length - DISMISS_LIMIT] + DISMISS_WINDOW_MS;
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const nowMs = toMs(now ?? Date.now());
  await withUserState(userId, async (state, save) => {
    const list = (state.dismissals[type] || []).filter((t) => t > nowMs - DISMISS_WINDOW_MS);
    list.push(nowMs);
    state.dismissals[type] = list.slice(-20);
    await save();
  });
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now ?? Date.now());
  const type = candidate.type;
  const result = { push: false, inApp: false, reason: null, resumeAt: null };

  // The user switched this kind of notification off: nothing at all.
  if (user.categories && user.categories[type] === false) {
    result.reason = 'The user turned off this kind of notification.';
    return result;
  }

  try {
    return await withUserState(user.id, async (state, save) => {
      const prior = state.delivered[candidate.id] || {};

      // ---- in-app item (quiet, stored once per candidate) ----
      if (prior.inApp) {
        result.inApp = true;
      } else {
        try {
          await transport.inApp(user, candidate);
          result.inApp = true;
          state.delivered[candidate.id] = { ...prior, inApp: true, at: nowMs };
          await save();
        } catch {
          // reported through result.inApp = false
        }
      }

      // ---- decide whether the push may go out ----
      const blockers = []; // { text, until } ; until = ms or null when only the user/system can change it
      const tz = user.timezone;
      const zoneOk = validZone(tz);

      if (prior.push) {
        result.push = false;
        result.reason = 'This notification was already pushed.';
        return finish(result, [], state);
      }

      if (user.notificationsPermitted === false) {
        blockers.push({ text: 'Notifications are turned off for this app in the phone settings.', until: null });
      }
      if (!user.categories || user.categories[type] !== true) {
        blockers.push({ text: 'The user has not chosen to receive this kind of notification yet.', until: null });
      }

      let consents = null;
      try {
        consents = await consentStore.get(user.id);
      } catch {
        blockers.push({ text: 'Consent could not be checked right now, so no push was sent.', until: null });
        consents = undefined;
      }
      if (consents !== undefined) {
        const keys = ['push', 'notifications', type].filter((k) => consents && typeof consents === 'object' && k in consents);
        if (keys.some((k) => consents[k] === false) || !keys.some((k) => consents[k] === true)) {
          blockers.push({ text: 'The user has not given consent for push notifications.', until: null });
        }
      }

      if (user.snoozedUntil != null) {
        const s = Date.parse(user.snoozedUntil);
        if (!Number.isFinite(s)) {
          blockers.push({ text: 'The snooze setting could not be read, so no push was sent.', until: null });
        } else if (s > nowMs) {
          blockers.push({ text: `Notifications are snoozed until ${iso(s)}.`, until: s });
        }
      }

      const pause = dismissalPause(state, type, nowMs);
      if (pause !== null && pause > nowMs) {
        blockers.push({ text: 'The user dismissed this kind of notification several times, so it is paused for now.', until: pause });
      }

      if (!zoneOk) {
        blockers.push({ text: 'The time zone of the user is unknown, so no push was sent.', until: null });
      } else {
        const last = state.pushDay[type];
        if (last && dayKey(last, tz) === dayKey(nowMs, tz)) {
          blockers.push({ text: 'A push of this kind was already sent today.', until: wakeNextDay(nowMs, tz) });
        }
        if (isQuiet(nowMs, tz)) {
          blockers.push({ text: `It is outside waking hours; push waits until ${String(WAKE_HOUR).padStart(2, '0')}:00 local time.`, until: nextWake(nowMs, tz) });
        }
      }

      if (blockers.length) return finish(result, blockers, state, { nowMs, tz: zoneOk ? tz : null });

      // ---- push ----
      let accepted = false;
      try {
        accepted = (await transport.push(user, candidate)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        result.push = true;
        state.delivered[candidate.id] = { ...(state.delivered[candidate.id] || {}), push: true, at: nowMs };
        state.pushDay[type] = nowMs;
        pruneDelivered(state);
        await save();
      } else {
        result.reason = 'The phone did not accept the push.';
        pruneDelivered(state);
        await save();
      }
      return result;
    });
  } catch {
    return { push: false, inApp: false, reason: 'Delivery state could not be read, so nothing was sent. Try again later.', resumeAt: null };
  }
}

function pruneDelivered(state) {
  const entries = Object.entries(state.delivered);
  if (entries.length <= KEEP_DELIVERED) return;
  entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  for (const [id] of entries.slice(0, entries.length - KEEP_DELIVERED)) delete state.delivered[id];
}

function finish(result, blockers, state, ctx) {
  if (blockers.length) {
    result.reason = blockers[0].text;
    if (blockers.every((b) => b.until !== null) && ctx?.tz) {
      let t = Math.max(...blockers.map((b) => b.until));
      if (isQuiet(t, ctx.tz)) t = nextWake(t, ctx.tz);
      result.resumeAt = iso(t);
    }
  }
  pruneDelivered(state);
  return result;
}
