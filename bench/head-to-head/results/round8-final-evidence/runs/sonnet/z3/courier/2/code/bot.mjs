import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Local-time rules (user's own timezone).
const BRIEFING_START_MIN = 7 * 60; // briefing push goes out from 07:00 ...
const BRIEFING_END_MIN = 10 * 60; // ... until 10:00; later it is stale and waits for the next morning
const QUIET_START_MIN = 22 * 60; // other push types: no push from 22:00 ...
const QUIET_END_MIN = 7 * 60; // ... until 07:00

// Repeated dismissals: DISMISS_LIMIT swipes of one type within DISMISS_WINDOW_MS stop its push.
const DISMISS_LIMIT = 3;
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000;

const PENDING_STALE_MS = 10 * 60 * 1000; // a worker that died mid-send releases its claim after this
const KEEP_MS = 30 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 20 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- shared state (one JSON file + one lock directory per user) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function paths(userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  const dir = stateDir();
  return { dir, file: join(dir, `${h}.json`), lock: join(dir, `${h}.lock`) };
}

async function withLock(userId, fn) {
  const p = paths(userId);
  await mkdir(p.dir, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(p.lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(p.lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rmdir(p.lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry now
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for state lock');
      await sleep(5 + Math.random() * 25);
    }
  }
  try {
    const state = await load(p.file);
    const result = await fn(state);
    await save(p, state);
    return result;
  } finally {
    await rmdir(p.lock).catch(() => {});
  }
}

async function load(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (s && typeof s === 'object') return { sent: s.sent ?? {}, pushDays: s.pushDays ?? {}, dismissals: s.dismissals ?? {} };
  } catch {
    // missing file: fresh state
  }
  return { sent: {}, pushDays: {}, dismissals: {} };
}

async function save(p, state) {
  const tmp = `${p.file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, p.file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

function prune(state, nowMs) {
  for (const [id, r] of Object.entries(state.sent)) if (nowMs - r.at > KEEP_MS) delete state.sent[id];
  for (const [day, r] of Object.entries(state.pushDays)) if (nowMs - r.at > KEEP_MS) delete state.pushDays[day];
  for (const [type, list] of Object.entries(state.dismissals)) {
    state.dismissals[type] = list.filter((t) => nowMs - t < DISMISS_WINDOW_MS * 2);
    if (!state.dismissals[type].length) delete state.dismissals[type];
  }
}

// ---------- time zone helpers ----------

function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of parts) o[x.type] = Number(x.value);
  return o;
}

const offsetMs = (ms, tz) => {
  const l = localParts(ms, tz);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000;
};

// UTC ms of local wall time y-m-d minutes-of-day in tz (DST safe by iteration).
function localToUtc(y, m, d, minutes, tz) {
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

// Next UTC ms strictly after nowMs at which local clock reads `minutes`.
function nextLocalTime(nowMs, tz, minutes) {
  const l = localParts(nowMs, tz);
  for (let add = 0; add <= 2; add++) {
    const t = localToUtc(l.year, l.month, l.day + add, minutes, tz);
    if (t > nowMs) return t;
  }
  return null;
}

// ---------- decision ----------

const iso = (ms) => new Date(ms).toISOString();

async function deliver({ user, candidate, now, transport, consentStore }) {
  if (!user || user.id == null || !candidate || candidate.id == null) throw new TypeError('user and candidate with ids are required');
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('invalid now');
  const type = candidate.type;
  const isBriefing = type === 'briefing';
  const label = isBriefing ? 'morning briefing' : `"${type}"`;

  const none = (reason, resumeAt = null) => ({ push: false, inApp: false, reason, resumeAt });

  // 1. The user's own choices apply to every surface.
  const choice = user.categories?.[type];
  if (choice === false) return none(`You turned off ${label} notifications.`);

  const snoozedMs = user.snoozedUntil == null ? null : Date.parse(user.snoozedUntil);
  if (snoozedMs != null && !Number.isNaN(snoozedMs) && snoozedMs > nowMs) {
    return none(`Notifications are snoozed until ${iso(snoozedMs)}.`, iso(snoozedMs));
  }

  // 2. Push-only blockers. blocks[] = { reason, resumeMs | null (needs the user to act) }.
  const blocks = [];
  if (snoozedMs != null && Number.isNaN(snoozedMs)) blocks.push({ reason: 'The snooze setting could not be read, so no push was sent.', resumeMs: null });
  if (choice !== true) blocks.push({ reason: `You have not chosen to receive ${label} notifications.`, resumeMs: null });
  if (user.notificationsPermitted === false) blocks.push({ reason: 'Notifications are turned off for this app in the phone settings.', resumeMs: null });

  const tz = user.timezone;
  let localDay = null;
  try {
    const l = localParts(nowMs, tz);
    localDay = `${l.year}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
    const minute = l.hour * 60 + l.minute;
    if (isBriefing) {
      if (minute < BRIEFING_START_MIN || minute >= BRIEFING_END_MIN) {
        blocks.push({ reason: 'The morning briefing is only pushed in the morning, local time.', resumeMs: nextLocalTime(nowMs, tz, BRIEFING_START_MIN) });
      }
    } else if (minute >= QUIET_START_MIN || minute < QUIET_END_MIN) {
      blocks.push({ reason: 'It is night where the user is, so the push waits.', resumeMs: nextLocalTime(nowMs, tz, QUIET_END_MIN) });
    }
  } catch {
    blocks.push({ reason: 'The time zone of the user is unknown, so no push was sent.', resumeMs: null });
  }

  // Consent is only needed (and only asked) when push is otherwise possible. Fail closed.
  if (!blocks.length) {
    try {
      const consents = await consentStore.get(user.id);
      if (!consents || typeof consents !== 'object') throw new Error('no consents');
      if (consents.push === false || consents.notifications === false) {
        blocks.push({ reason: 'The user has not given consent for push notifications.', resumeMs: null });
      }
    } catch {
      blocks.push({ reason: 'Consent could not be checked, so no push was sent.', resumeMs: null });
    }
  }

  // 3. Shared state: duplicates, daily briefing cap, dismissal fatigue, claim before sending.
  const plan = await withLock(user.id, (state) => {
    prune(state, nowMs);
    const rec = state.sent[candidate.id] ?? { push: false, inApp: false, at: nowMs };
    if (rec.pending && nowMs - rec.pending < PENDING_STALE_MS) return { busy: true };
    if (rec.push && rec.inApp) return { done: true };

    const pushBlocks = [...blocks];
    const recent = (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISS_WINDOW_MS).sort((a, b) => b - a);
    if (recent.length >= DISMISS_LIMIT) {
      pushBlocks.push({ reason: `You swiped away several ${label} cards recently, so pushes for them are paused.`, resumeMs: recent[DISMISS_LIMIT - 1] + DISMISS_WINDOW_MS });
    }
    const dayRec = isBriefing && localDay ? state.pushDays[localDay] : null;
    if (dayRec && dayRec.id !== candidate.id) {
      return { sameDay: true, resumeMs: nextLocalTime(nowMs, tz, BRIEFING_START_MIN) };
    }

    const doPush = !rec.push && pushBlocks.length === 0;
    const doInApp = !rec.inApp;
    if (!doPush && !doInApp) return { pushBlocks, nothing: true };
    rec.pending = nowMs;
    rec.at = nowMs;
    state.sent[candidate.id] = rec;
    if (doPush && isBriefing && localDay) state.pushDays[localDay] = { id: candidate.id, at: nowMs };
    return { doPush, doInApp, pushBlocks };
  });

  if (plan.busy) return none('This notification is already being delivered.');
  if (plan.done) return none('This notification was already delivered.');
  if (plan.sameDay) return none('Today’s morning briefing was already sent.', plan.resumeMs ? iso(plan.resumeMs) : null);

  const why = (pushBlocks) => {
    if (!pushBlocks.length) return { reason: null, resumeAt: null };
    const permanent = pushBlocks.some((b) => b.resumeMs == null);
    const resumeMs = permanent ? null : Math.max(...pushBlocks.map((b) => b.resumeMs));
    return { reason: pushBlocks[0].reason, resumeAt: resumeMs == null ? null : iso(resumeMs) };
  };
  if (plan.nothing) return { push: false, inApp: false, ...why(plan.pushBlocks) };

  // 4. Send. Failures of one surface do not stop the other.
  let push = false;
  let inApp = false;
  let failure = null;
  if (plan.doPush) {
    try {
      push = (await transport.push(user, candidate)) === true;
      if (!push) failure = 'The phone did not accept the push (for example no device token).';
    } catch {
      failure = 'The push could not be sent because of an error.';
    }
  }
  if (plan.doInApp) {
    try {
      await transport.inApp(user, candidate);
      inApp = true;
    } catch {
      failure = failure ?? 'The in-app item could not be stored because of an error.';
    }
  }

  await withLock(user.id, (state) => {
    const rec = state.sent[candidate.id];
    if (rec) {
      if (push) rec.push = true;
      if (inApp) rec.inApp = true;
      delete rec.pending;
      rec.at = nowMs;
    }
    if (plan.doPush && !push && isBriefing && localDay && state.pushDays[localDay]?.id === candidate.id) delete state.pushDays[localDay];
  });

  const w = why(plan.pushBlocks);
  const reason = failure ?? w.reason;
  return { push, inApp, reason, resumeAt: reason === w.reason ? w.resumeAt : null };
}

async function recordDismissal(userId, type, now) {
  const nowMs = new Date(now ?? Date.now()).getTime();
  if (Number.isNaN(nowMs)) throw new TypeError('invalid now');
  await withLock(userId, (state) => {
    prune(state, nowMs);
    (state.dismissals[type] ??= []).push(nowMs);
    state.dismissals[type] = state.dismissals[type].slice(-20);
  });
}

export { deliver, recordDismissal };
