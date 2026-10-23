// Gate for the weekly digest SMS (US customers).
// Rules enforced here:
//  - opt-out (STOP etc.) is honored at once and stays across restarts; START re-subscribes
//  - no text between 9 pm and 8 am in the customer's own time zone (TCPA)
//  - one digest per message id (the queue redelivers) and at most one per week per customer
//  - fail closed: any error means "do not send"
import fs from 'node:fs/promises';
import path from 'node:path';

const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // weekly digest; 6 days leaves room for delivery jitter
const MAX_AGE_MS = 48 * 3600 * 1000; // a digest older than this is stale
const SEND_FROM_HOUR = 8; // local time, inclusive
const SEND_UNTIL_HOUR = 21; // local time, exclusive
const LOCK_STALE_MS = 15000;

const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START_WORDS = new Set(['start', 'unstop']);

const HELP_REPLY =
  'Reminder bot: weekly digest texts. Msg&data rates may apply. Reply STOP to cancel, START to resume. For support contact customer support in the app.';
const STOP_REPLY = 'You are unsubscribed and will get no more texts from us. Reply START to resubscribe.';
const START_REPLY = 'You are subscribed to the weekly digest again. Reply STOP to cancel, HELP for help.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function acquireLock(dir) {
  const lock = path.join(dir, 'state.lock');
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fs.mkdir(lock);
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await fs.stat(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // rename is atomic: only one process wins the right to remove a stale lock
        const grave = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
        await fs.rename(lock, grave);
        await fs.rm(grave, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // lock vanished or was taken over; retry
    }
    if (Date.now() > deadline) throw new Error('could not get the state lock');
    await sleep(5 + Math.random() * 15);
  }
}

// Run fn(state) with the cross-process lock held; save state if fn returns truthy "dirty" flag.
async function withState(fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lock = await acquireLock(dir);
  try {
    const file = path.join(dir, 'state.json');
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // corrupt state: fail closed
      state = {};
    }
    state.optedOut ??= {}; // "userId:channel" -> ISO time
    state.sentIds ??= {}; // message id -> ISO time
    state.lastSent ??= {}; // userId -> ms
    const result = await fn(state);
    if (result.dirty) {
      const tmp = `${file}.${process.pid}.tmp`;
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(state));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
    }
    return result.value;
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

const optKey = (userId, channel) => `${userId}:${channel}`;

export async function trySend({ user, message, now }) {
  const no = (reason) => ({ sent: false, reason });
  try {
    if (!user || user.id == null || !message || message.id == null) return no('Missing user or message data.');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');
    if (message.channel !== 'sms') return no('This gate only handles sms messages.');

    const created = new Date(message.createdAt);
    if (Number.isNaN(created.getTime())) return no('The digest creation time is not valid.');
    if (now.getTime() - created.getTime() > MAX_AGE_MS) return no('The digest is too old to send.');

    let hour;
    try {
      hour = localHour(now, user.timezone);
    } catch {
      return no('The customer time zone is not valid, so quiet hours cannot be checked.');
    }
    if (!Number.isInteger(hour)) return no('The customer local time could not be determined.');

    return await withState((state) => {
      const msgId = String(message.id);
      if (state.optedOut[optKey(user.id, 'sms')]) return { value: no('The customer opted out of texts.') };
      if (state.sentIds[msgId]) return { value: no('This digest was already sent.') };
      if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) {
        return { value: no('It is outside 8 am to 9 pm in the customer local time.') };
      }
      const last = state.lastSent[user.id];
      if (last !== undefined && now.getTime() - last < MIN_GAP_MS) {
        return { value: no('The customer already got a digest in the last week.') };
      }
      state.sentIds[msgId] = now.toISOString();
      state.lastSent[user.id] = now.getTime();
      return { dirty: true, value: { sent: true, reason: 'OK to send.' } };
    });
  } catch (e) {
    return no(`Not sent because of an internal error: ${e.message}`);
  }
}

export async function optOut(userId, channel = 'sms') {
  await withState((state) => {
    state.optedOut[optKey(userId, channel)] = new Date().toISOString();
    return { dirty: true, value: undefined };
  });
}

async function optIn(userId, channel, now) {
  await withState((state) => {
    delete state.optedOut[optKey(userId, channel)];
    // a fresh opt-in must not be blocked or confused by earlier send history
    return { dirty: true, value: undefined };
  });
}

function classify(text) {
  const words = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return 'other';
  // "opt out" as two words
  const joined = words.join('');
  if (words.length <= 4 && (words.some((w) => OPT_OUT_WORDS.has(w)) || joined === 'optout')) return 'stop';
  if (words.length === 1 && words[0] === 'help') return 'help';
  if (words.length === 1 && START_WORDS.has(words[0])) return 'start';
  if (words.length <= 4 && words[0] === 'help') return 'help';
  return 'other';
}

// Returns { action, reply }. reply is the one text the caller may send back, or null.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms') return { action: 'ignored', reply: null };
  const kind = classify(text);
  if (kind === 'stop') {
    await optOut(userId, channel);
    return { action: 'opted_out', reply: STOP_REPLY };
  }
  if (kind === 'start') {
    await optIn(userId, channel, now);
    return { action: 'opted_in', reply: START_REPLY };
  }
  if (kind === 'help') return { action: 'help', reply: HELP_REPLY };
  return { action: 'none', reply: null };
}
