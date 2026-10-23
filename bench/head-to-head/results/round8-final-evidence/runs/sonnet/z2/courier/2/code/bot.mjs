// Weekly digest SMS gate. No dependencies. State lives in STATE_DIR as small files,
// so several worker processes can share it without locks:
//   optout/<hash(userId|channel)>  exists = customer opted out
//   sent/<hash(messageId)>         created with O_EXCL = digest claimed as sent
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Texts go out only between 08:00 and 20:00 recipient local time. TCPA allows
// 08:00-21:00, but several states (FL, OK, MD, WA) end at 20:00.
const FIRST_HOUR = 8;
const LAST_HOUR = 20; // exclusive

const STOP_WORDS = new Set([
  'stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'revoke',
]);
const STOP_FIRST_WORDS = new Set(['stop', 'stopall', 'unsubscribe']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);

const STOP_REPLY = 'You are unsubscribed and will get no more texts from us. Reply START to subscribe again.';
const START_REPLY = 'You are subscribed to the weekly digest again. Msg&data rates may apply. Reply HELP for help, STOP to cancel.';
const HELP_REPLY = 'Weekly digest texts from our reminder service. For help email support@example.com. Msg&data rates may apply. Reply STOP to cancel.';

function dirs() {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  return { optout: path.join(root, 'optout'), sent: path.join(root, 'sent') };
}

async function ensureDirs() {
  const d = dirs();
  await mkdir(d.optout, { recursive: true });
  await mkdir(d.sent, { recursive: true });
  return d;
}

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const exists = (p) => access(p).then(() => true, () => false);
const optOutFile = (d, userId, channel) => path.join(d.optout, hash(`${userId}|${channel}`));

function localHour(timezone, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour').value);
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

export async function trySend({ user, message, now }) {
  const d = await ensureDirs();
  const no = (reason) => ({ sent: false, reason });

  if (!user?.id || !message?.id) return no('Missing user or message id.');
  if (message.channel !== 'sms') return no('Only the sms channel is supported.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is invalid.');

  const claim = path.join(d.sent, hash(message.id));
  if (await exists(claim)) return no('This digest was already sent.');
  if (await exists(optOutFile(d, user.id, 'sms'))) return no('The customer opted out of texts.');

  const hour = localHour(user.timezone, now);
  if (hour === null) return no('The customer time zone is unknown, so quiet hours cannot be checked.');
  if (hour < FIRST_HOUR || hour >= LAST_HOUR) {
    return no('It is outside 8am-8pm in the customer local time; try again later.');
  }

  // Claim the digest atomically: exactly one worker wins, even on redelivery.
  try {
    await writeFile(claim, JSON.stringify({ userId: user.id, at: now.toISOString() }), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return no('This digest was already sent.');
    throw e;
  }

  // Re-check after claiming: an opt-out that landed during the checks above still wins.
  if (await exists(optOutFile(d, user.id, 'sms'))) {
    await rm(claim, { force: true });
    return no('The customer opted out of texts.');
  }
  return { sent: true, reason: 'Allowed to send now.' };
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns { reply }: text the app should send back to the customer, or null for none.
export async function handleInbound({ userId, channel, text, now }) {
  if (channel !== 'sms') return { reply: null };
  const t = normalize(text);
  const first = t.split(' ')[0];

  if (STOP_WORDS.has(t) || STOP_FIRST_WORDS.has(first)) {
    await optOut(userId, channel, now);
    return { reply: STOP_REPLY };
  }
  if (HELP_WORDS.has(t)) return { reply: HELP_REPLY };
  if (START_WORDS.has(t)) {
    const d = await ensureDirs();
    await rm(optOutFile(d, userId, 'sms'), { force: true });
    return { reply: START_REPLY };
  }
  return { reply: null };
}

export async function optOut(userId, channel = 'sms', now = new Date()) {
  const d = await ensureDirs();
  const at = now instanceof Date ? now.toISOString() : new Date().toISOString();
  await writeFile(optOutFile(d, userId, channel), JSON.stringify({ userId, channel, at }));
}
