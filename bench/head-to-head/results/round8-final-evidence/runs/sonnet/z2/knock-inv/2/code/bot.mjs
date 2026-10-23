// SMS weekly digest gate. Several worker processes share STATE_DIR.
// Per-user state lives in one JSON file; a lock file serializes read-modify-write across processes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SEND_START_HOUR = 8; // recipient local time, inclusive (TCPA allows 8am-9pm; we stop at 8pm to be safe)
const SEND_END_HOUR = 20; // exclusive
const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // one digest per week; 6 days tolerates quiet-hour deferrals
const KEEP_IDS_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 15000;

// CTIA / carrier stop keywords, plus resume and help keywords.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

const STOP_REPLY = 'You are unsubscribed from weekly digest texts and will get no more. Reply START to resubscribe.';
const START_REPLY = 'You are subscribed to weekly digest texts. Msg&data rates may apply. Reply STOP to unsubscribe, HELP for help.';
const HELP_REPLY = 'Weekly digest texts. Reply STOP to unsubscribe. Msg&data rates may apply.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${h}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const file = userFile(userId);
  const lock = file + '.lock';
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.unlink(lock).catch(() => {});
      } catch {}
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn(file);
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

async function load(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, sent: {}, lastSentAt: null, log: [] };
    throw e;
  }
}

async function save(file, state) {
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

function localHour(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    return Number.isFinite(h) ? h : null;
  } catch {
    return null;
  }
}

function toDate(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function record(state, event, at) {
  state.log.push({ event, at: at.toISOString() });
  if (state.log.length > 50) state.log.splice(0, state.log.length - 50);
}

export async function trySend({ user, message, now }) {
  const at = toDate(now);
  if (!user?.id || !message?.id) return { sent: false, reason: 'Missing user or message id.' };
  if (message.channel !== 'sms') return { sent: false, reason: 'This gate only handles the sms channel.' };

  return withLock(user.id, async (file) => {
    const state = await load(file);

    // Opt-out wins over everything, including a redelivery of an earlier message.
    if (state.optedOut.sms) return { sent: false, reason: 'The customer opted out of texts.' };

    if (state.sent[message.id]) return { sent: false, reason: 'This digest was already sent.' };

    const hour = localHour(at, user.timezone);
    if (hour === null) return { sent: false, reason: 'The customer time zone is unknown, so we cannot check quiet hours.' };
    if (hour < SEND_START_HOUR || hour >= SEND_END_HOUR) {
      return { sent: false, reason: 'It is outside 8am to 8pm in the customer local time.' };
    }

    if (state.lastSentAt && at.getTime() - Date.parse(state.lastSentAt) < MIN_GAP_MS) {
      return { sent: false, reason: 'A digest text was already sent to this customer this week.' };
    }

    for (const [id, t] of Object.entries(state.sent)) {
      if (at.getTime() - Date.parse(t) > KEEP_IDS_MS) delete state.sent[id];
    }
    state.sent[message.id] = at.toISOString();
    state.lastSentAt = at.toISOString();
    record(state, `sent ${message.id}`, at);
    await save(file, state);
    return { sent: true, reason: 'OK to send.' };
  });
}

async function setOptOut(userId, channel, value, source, at) {
  await withLock(userId, async (file) => {
    const state = await load(file);
    if (value) state.optedOut[channel] = at.toISOString();
    else delete state.optedOut[channel];
    record(state, `${value ? 'opt-out' : 'opt-in'} ${channel} via ${source}`, at);
    await save(file, state);
  });
}

export async function optOut(userId, channel) {
  await setOptOut(userId, channel || 'sms', true, 'account page', new Date());
}

export async function handleInbound({ userId, channel, text, now }) {
  const at = toDate(now);
  if (!userId || channel !== 'sms') return { handled: false };
  const word = String(text ?? '').trim().replace(/[^\p{L}\p{N}\s]/gu, '').trim().toUpperCase();
  if (STOP_WORDS.has(word)) {
    await setOptOut(userId, 'sms', true, 'text ' + word, at);
    return { handled: true, action: 'opt-out', reply: STOP_REPLY };
  }
  if (START_WORDS.has(word)) {
    await setOptOut(userId, 'sms', false, 'text ' + word, at);
    return { handled: true, action: 'opt-in', reply: START_REPLY };
  }
  if (HELP_WORDS.has(word)) return { handled: true, action: 'help', reply: HELP_REPLY };
  return { handled: false };
}
