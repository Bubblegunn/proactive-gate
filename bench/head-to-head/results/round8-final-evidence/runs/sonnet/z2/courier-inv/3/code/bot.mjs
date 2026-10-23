// SMS weekly-digest gate. No dependencies. Nothing is sent from here: trySend only decides.
//
// Rules enforced before a digest text may go out (US, TCPA / CTIA):
//   1. The customer has not opted out on this channel (STOP-type text, or the account page).
//   2. The same digest event id is never approved twice (queue redelivery, worker crash).
//   3. Only between 08:00 and 21:00 in the customer's own time zone.
//   4. At most one digest per customer per channel per 6 days.
// State is one JSON file per user in STATE_DIR, guarded by a per-user lock directory,
// so several worker processes can share it.

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const QUIET_START_HOUR = 8; // first allowed local hour
const QUIET_END_HOUR = 21; // first forbidden local hour
const MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
const ID_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

async function withLock(userId, fn) {
  const dir = await stateDir();
  const key = userKey(userId);
  const lockPath = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Holder probably crashed. Rename first so only one process breaks it.
          const grave = `${lockPath}.stale-${randomUUID()}`;
          await fs.rename(lockPath, grave);
          await fs.rm(grave, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or was taken over; retry
      }
      if (Date.now() > deadline) throw new Error('could not get the user state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    const file = path.join(dir, `${key}.json`);
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      state = { userId: String(userId), optedOut: {}, sent: {} };
    }
    const result = await fn(state);
    if (state.__dirty) {
      delete state.__dirty;
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(state));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
    }
    return result;
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function localHour(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

function recordOptOut(state, channel, source, now) {
  if (!state.optedOut[channel]) {
    state.optedOut[channel] = { at: now.toISOString(), source };
    state.__dirty = true;
  }
}

export async function optOut(userId, channel) {
  await withLock(userId, (state) => {
    recordOptOut(state, channel, 'account', new Date());
  });
}

export async function trySend({ user, message, now }) {
  now = now instanceof Date ? now : new Date(now ?? Date.now());
  if (!user?.id) return { sent: false, reason: 'No user id, so consent cannot be checked.' };
  if (!message?.id) return { sent: false, reason: 'The message has no id, so duplicates cannot be detected.' };
  const channel = message.channel;
  if (channel !== 'sms') return { sent: false, reason: 'This gate only handles the sms channel.' };
  if (Number.isNaN(now.getTime())) return { sent: false, reason: 'The current time is invalid.' };

  return withLock(user.id, (state) => {
    if (state.optedOut[channel]) {
      return { sent: false, reason: 'The customer has opted out of text messages.' };
    }
    const sent = (state.sent[channel] ??= { ids: {}, lastSentAt: null });
    if (sent.ids[message.id]) {
      return { sent: false, reason: 'This digest was already sent.' };
    }
    const hour = localHour(now, user.timezone);
    if (hour === null) {
      return { sent: false, reason: 'The customer time zone is missing or invalid, so quiet hours cannot be checked.' };
    }
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
      return { sent: false, reason: 'It is outside 8am to 9pm in the customer local time. Try again later.' };
    }
    if (sent.lastSentAt !== null && Math.abs(now.getTime() - Date.parse(sent.lastSentAt)) < MIN_GAP_MS) {
      return { sent: false, reason: 'A digest was already sent to this customer in the last 6 days.' };
    }

    for (const [id, at] of Object.entries(sent.ids)) {
      if (now.getTime() - Date.parse(at) > ID_RETENTION_MS) delete sent.ids[id];
    }
    sent.ids[message.id] = now.toISOString();
    sent.lastSentAt = now.toISOString();
    state.__dirty = true;
    return { sent: true, reason: 'OK to send.' };
  });
}

const STOP_EXACT = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT']);
const STOP_PHRASE = /\b(stop|stopall|unsubscribe|quit|revoke|opt[\s-]?out)\b/i;
const START_EXACT = new Set(['START', 'UNSTOP']);
const HELP_EXACT = new Set(['HELP', 'INFO']);

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .trim()
    .replace(/[\s.!?,;:]+$/g, '')
    .replace(/^[\s.!?,;:]+/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export async function handleInbound({ userId, channel, text, now }) {
  now = now instanceof Date ? now : new Date(now ?? Date.now());
  if (channel !== 'sms') return { action: 'ignored' };
  const norm = normalize(text);

  // Fail toward opting out: exact keywords, or a clear stop phrase anywhere in the text.
  if (STOP_EXACT.has(norm) || STOP_PHRASE.test(norm)) {
    await withLock(userId, (state) => recordOptOut(state, channel, 'inbound', now));
    return { action: 'opted_out', reply: 'You are unsubscribed and will get no more messages. Reply START to subscribe again.' };
  }
  if (HELP_EXACT.has(norm)) {
    return { action: 'help', reply: 'Weekly digest texts. Msg freq: weekly. Msg&data rates may apply. Reply STOP to cancel.' };
  }
  if (START_EXACT.has(norm)) {
    await withLock(userId, (state) => {
      if (state.optedOut[channel]) {
        delete state.optedOut[channel];
        state.__dirty = true;
      }
    });
    return { action: 'opted_in', reply: 'You are subscribed to the weekly digest again. Reply STOP to cancel.' };
  }
  return { action: 'none' };
}
