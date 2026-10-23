// Gate for the weekly digest SMS. Nothing here sends a text.
// State: one JSON file in STATE_DIR, changed only while holding a lock directory,
// so several worker processes on one machine can share it.
import fs from 'node:fs/promises';
import path from 'node:path';

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 20; // texts stop at 20:00 local (strictest US state rules: FL, OK, MD, WA)
const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // at most one digest per user per 6 days
const LOCK_STALE_MS = 15000;

const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const OPT_OUT_PHRASES = /\b(stop|unsubscribe|opt[\s-]?out|quit|revoke|cancel|(do not|don'?t|no more)\s+(text|message|contact))/i;
const OPT_IN_WORDS = new Set(['start', 'unstop']);
const HELP_WORDS = new Set(['help', 'info']);

const REPLY_STOP = 'You are unsubscribed and will get no more weekly digest texts. Reply START to subscribe again.';
const REPLY_START = 'You are subscribed to the weekly digest texts. Msg & data rates may apply. Reply HELP for help, STOP to unsubscribe.';
const REPLY_HELP = 'Weekly digest texts. Msg & data rates may apply. Reply STOP to unsubscribe, START to subscribe again.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function acquireLock(dir) {
  const lock = path.join(dir, 'state.lock');
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner'), String(process.pid));
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'ENOENT') throw e;
    }
    try {
      const st = await fs.stat(lock);
      let owner = NaN;
      try {
        owner = Number(await fs.readFile(path.join(lock, 'owner'), 'utf8'));
      } catch {}
      const old = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      if (old || (Number.isInteger(owner) && owner > 0 && !pidAlive(owner) && Date.now() - st.mtimeMs > 500)) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch {}
    await sleep(5 + Math.random() * 15);
  }
}

// Serialize callers inside this process too (the directory lock is not re-entrant).
let chain = Promise.resolve();

function withState(fn) {
  const run = chain.then(async () => {
    const dir = stateDir();
    await fs.mkdir(dir, { recursive: true });
    const lock = await acquireLock(dir);
    try {
      const file = path.join(dir, 'state.json');
      let state;
      try {
        state = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e; // corrupt state: fail closed, send nothing
        state = {};
      }
      state.optedOut ??= {};
      state.sent ??= {};
      state.lastSent ??= {};
      const result = await fn(state);
      const tmp = path.join(dir, `state.${process.pid}.tmp`);
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(state));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
      return result;
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  });
  chain = run.catch(() => {});
  return run;
}

function localHour(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

const key = (userId, channel) => `${userId}|${channel}`;

export async function trySend({ user, message, now }) {
  try {
    if (!user?.id || !message?.id) return { sent: false, reason: 'Missing user or message id.' };
    if (message.channel !== 'sms') return { sent: false, reason: 'This gate only handles sms.' };
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { sent: false, reason: 'Invalid current time.' };

    const hour = localHour(now, user.timezone);
    if (hour === null) return { sent: false, reason: 'Unknown time zone, so quiet hours cannot be checked.' };

    return await withState((state) => {
      const k = key(user.id, message.channel);
      const msgKey = `${message.channel}|${message.id}`;
      if (state.sent[msgKey]) return { sent: false, reason: 'This digest was already sent.' };
      if (state.optedOut[k]) return { sent: false, reason: 'The customer opted out of texts.' };
      if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
        return { sent: false, reason: 'Quiet hours: texts go out only from 8am to 8pm in the customer\'s local time.' };
      }
      const last = state.lastSent[k];
      if (last && now.getTime() - Date.parse(last) < MIN_GAP_MS) {
        return { sent: false, reason: 'A digest was already sent to this customer in the last 6 days.' };
      }
      state.sent[msgKey] = { userId: user.id, at: now.toISOString() };
      state.lastSent[k] = now.toISOString();
      return { sent: true, reason: 'OK to send.' };
    });
  } catch (e) {
    return { sent: false, reason: `Could not check state (${e.message}); not sending.` };
  }
}

// Returns { reply } with the text to answer with (or null for no reply). The app sends it.
export async function handleInbound({ userId, channel, text, now }) {
  const norm = String(text ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const at = (now instanceof Date ? now : new Date()).toISOString();
  if (OPT_OUT_WORDS.has(norm) || OPT_OUT_PHRASES.test(norm)) {
    await withState((state) => {
      state.optedOut[key(userId, channel)] = { at, via: 'inbound' };
    });
    return { reply: REPLY_STOP };
  }
  if (OPT_IN_WORDS.has(norm)) {
    await withState((state) => {
      delete state.optedOut[key(userId, channel)];
    });
    return { reply: REPLY_START };
  }
  if (HELP_WORDS.has(norm)) return { reply: REPLY_HELP };
  return { reply: null };
}

export async function optOut(userId, channel) {
  await withState((state) => {
    state.optedOut[key(userId, channel)] = { at: new Date().toISOString(), via: 'account' };
  });
}
