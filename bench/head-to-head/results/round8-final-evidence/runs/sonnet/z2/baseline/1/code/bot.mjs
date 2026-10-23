// Compliance gate for the weekly digest text (US SMS).
//
// Rules enforced in trySend:
//   - the same digest event id is sent at most once (queue redelivery, worker crash)
//   - no text to a user who opted out (STOP keyword, account page)
//   - no text outside 08:00-20:00 in the user's own time zone (TCPA allows 08:00-21:00;
//     some states end at 20:00, and a time zone does not tell us the state)
//   - at most one digest per user per 6 days
//
// All state lives in one JSON file in STATE_DIR. Every read-modify-write happens under
// a lock directory, so several worker processes on one machine stay consistent.

import fs from 'node:fs/promises';
import path from 'node:path';

const QUIET_START_HOUR = 8;
const QUIET_END_HOUR = 20;
const MIN_GAP_MS = 6 * 24 * 3600 * 1000;
const SENT_ID_TTL_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 30 * 1000;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out', 'opt-out']);
const STOP_FIRST_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);

const SUPPORT = process.env.SUPPORT_CONTACT ? ` Contact: ${process.env.SUPPORT_CONTACT}.` : '';
export const REPLIES = {
  stop: 'You are unsubscribed from weekly digest texts. You will get no more messages. Reply START to subscribe again.',
  start: 'You are subscribed to weekly digest texts again. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.',
  help: `Weekly digest texts. Msg & data rates may apply. Reply STOP to unsubscribe.${SUPPORT}`,
};

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

async function acquireLock(lockPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'pid'), String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Break a lock only when its owner is gone and it is old.
    try {
      const st = await fs.stat(lockPath);
      let owner = NaN;
      try { owner = Number(await fs.readFile(path.join(lockPath, 'pid'), 'utf8')); } catch {}
      const old = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      if (old && (Number.isNaN(owner) || !pidAlive(owner))) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {}
    await sleep(5 + Math.random() * 15);
  }
}

async function withState(fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, 'state.lock');
  const file = path.join(dir, 'state.json');
  await acquireLock(lockPath);
  try {
    let state = { users: {}, sent: {} };
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // a corrupt file must stop sending, not reset opt-outs
    }
    state.users ??= {};
    state.sent ??= {};
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    return result;
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function userRec(state, userId) {
  return (state.users[userId] ??= { optedOut: {}, lastSent: {} });
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  if (!user?.id || !message?.id) return no('Missing user or message id.');
  if (message.channel !== 'sms') return no('Only the sms channel is supported.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('Current time is invalid.');
  let hour;
  try {
    hour = localHour(now, user.timezone);
  } catch {
    return no('The user time zone is unknown, so quiet hours cannot be checked.');
  }
  if (Number.isNaN(hour)) return no('The user time zone is unknown, so quiet hours cannot be checked.');

  return withState((state) => {
    const nowMs = now.getTime();
    for (const [id, at] of Object.entries(state.sent)) {
      if (nowMs - Date.parse(at) > SENT_ID_TTL_MS) delete state.sent[id];
    }
    const rec = userRec(state, user.id);
    const ch = message.channel;
    if (state.sent[message.id]) return no('This digest was already sent.');
    if (rec.optedOut[ch]) return no('The user opted out of texts.');
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
      return no(`It is quiet hours for the user (allowed ${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00 local time).`);
    }
    const last = rec.lastSent[ch];
    if (last && nowMs - Date.parse(last) < MIN_GAP_MS) return no('The user already got a digest in the last 6 days.');
    state.sent[message.id] = now.toISOString();
    rec.lastSent[ch] = now.toISOString();
    return { sent: true, reason: 'OK to send.' };
  });
}

export async function optOut(userId, channel) {
  await withState((state) => {
    const rec = userRec(state, userId);
    rec.optedOut[channel] ??= new Date().toISOString();
  });
}

function classify(text) {
  const t = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (STOP_WORDS.has(t) || STOP_FIRST_WORDS.has(t.split(' ')[0])) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  if (HELP_WORDS.has(t)) return 'help';
  return null;
}

// Returns { action, reply }. `reply` is the text to send back, or null for no reply.
// The app must send the reply; it is a direct answer to the customer's message.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms' || !userId) return { action: 'ignored', reply: null };
  const kind = classify(text);
  if (!kind) return { action: 'none', reply: null };
  if (kind === 'help') return { action: 'help', reply: REPLIES.help };
  return withState((state) => {
    const rec = userRec(state, userId);
    const at = (now instanceof Date ? now : new Date()).toISOString();
    if (kind === 'stop') {
      if (rec.optedOut.sms) return { action: 'already-opted-out', reply: null };
      rec.optedOut.sms = at;
      return { action: 'opted-out', reply: REPLIES.stop };
    }
    if (!rec.optedOut.sms) return { action: 'none', reply: null };
    delete rec.optedOut.sms;
    return { action: 'opted-in', reply: REPLIES.start };
  });
}
