// Weekly digest SMS gate for US customers (TCPA / CTIA rules).
// State: one JSON file per user+channel in STATE_DIR, guarded by a lock directory,
// so several worker processes on one machine can share it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SEND_FROM_HOUR = 9; // local time, inclusive (stricter than the federal 8am; some states stop at 8pm)
const SEND_UNTIL_HOUR = 20; // local time, exclusive
const MIN_GAP_MS = 6 * 24 * 3600 * 1000; // one digest per week, with slack for delayed sends
const MAX_AGE_MS = 24 * 3600 * 1000; // a digest older than this is stale: do not send
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const STOP_ANYWHERE = new Set(['stop', 'stopall', 'unsubscribe', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);

const REPLY_STOP = 'You are unsubscribed and will receive no more text messages from us. Reply START to subscribe again.';
const REPLY_START = 'You are subscribed to the weekly digest again. Msg frequency: about 1/week. Msg&data rates may apply. Reply HELP for help, STOP to cancel.';
const REPLY_HELP = 'Weekly digest reminders. Msg frequency: about 1/week. Msg&data rates may apply. Reply STOP to cancel, START to resubscribe.';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyFor(userId, channel) {
  return crypto.createHash('sha256').update(JSON.stringify([String(userId), String(channel)])).digest('hex');
}

async function withLock(userId, channel, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, keyFor(userId, channel));
  const lock = base + '.lock';
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // rename is atomic: only one process wins the takeover
          const grave = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`;
          await fs.rename(lock, grave);
          await fs.rm(grave, { recursive: true, force: true });
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
      }
      if (Date.now() > deadline) throw new Error('could not get state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(base + '.json');
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function load(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: false, lastSentAt: null, sentIds: {} };
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

function localHour(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

const no = (reason) => ({ sent: false, reason });

export async function trySend({ user, message, now }) {
  if (!user?.id || !message?.id) return no('Missing user or message id.');
  if (message.channel !== 'sms') return no('Only the sms channel is supported.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('Invalid current time.');

  const created = new Date(message.createdAt);
  if (Number.isNaN(created.getTime())) return no('Message has no valid creation time.');
  if (now.getTime() - created.getTime() > MAX_AGE_MS) return no('The digest is too old to send.');

  const hour = typeof user.timezone === 'string' ? localHour(now, user.timezone) : null;
  if (hour === null) return no('Unknown time zone, so local quiet hours cannot be checked.');

  return withLock(user.id, 'sms', async (file) => {
    const s = await load(file);
    if (s.optedOut) return no('The customer opted out of texts.');
    if (s.sentIds[message.id]) return no('This digest was already sent.');
    if (s.lastSentAt !== null && now.getTime() - s.lastSentAt < MIN_GAP_MS) {
      return no('A digest was already sent in the past week.');
    }
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) {
      return no('Quiet hours: it is outside 9am to 8pm in the customer\'s local time.');
    }
    s.sentIds[message.id] = now.getTime();
    s.lastSentAt = now.getTime();
    await save(file, s);
    return { sent: true, reason: 'Sent.' };
  });
}

function classify(text) {
  const norm = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const first = tokens[0];
  if (STOP_WORDS.has(first) || tokens.some((t) => STOP_ANYWHERE.has(t))) return 'stop';
  if (tokens.length === 1 && START_WORDS.has(first)) return 'start';
  if (tokens.length === 1 && HELP_WORDS.has(first)) return 'help';
  return null;
}

export async function handleInbound({ userId, channel, text, now }) {
  const kind = channel === 'sms' ? classify(text) : null;
  if (kind === 'stop') {
    await optOut(userId, channel);
    return { action: 'opted-out', reply: REPLY_STOP };
  }
  if (kind === 'start') {
    await withLock(userId, channel, async (file) => {
      const s = await load(file);
      s.optedOut = false;
      s.optedInAt = (now instanceof Date ? now : new Date()).getTime();
      await save(file, s);
    });
    return { action: 'opted-in', reply: REPLY_START };
  }
  if (kind === 'help') return { action: 'help', reply: REPLY_HELP };
  return { action: 'none', reply: null };
}

export async function optOut(userId, channel) {
  await withLock(userId, channel, async (file) => {
    const s = await load(file);
    s.optedOut = true;
    s.optedOutAt = Date.now();
    await save(file, s);
  });
}
