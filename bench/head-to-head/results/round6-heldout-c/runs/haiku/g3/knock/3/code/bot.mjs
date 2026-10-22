// Email consent gate for newsletters (marketing) and receipts (transactional).
//
// State: one append-only log per address under $STATE_DIR/subs/<sha256>.jsonl.
// Each record is one JSON line written with O_APPEND and fsynced before the
// call resolves. The last complete record for an address decides its marketing
// status. No timestamps are used for ordering, so workers that write in the
// same second cannot reorder each other's events. File order is the order.
//
// Rules:
// - marketing mail needs a recorded opt-in (resubscribe) and no unsubscribe
//   after it. Opt-in is required because EU rules (ePrivacy) require prior
//   consent and we cannot tell where a recipient is from this API.
// - receipt mail is transactional and is not blocked by a marketing unsubscribe.
// - an address that fails validation gets no mail of either kind.
// - errors reject; a worker must treat a rejection as "do not send".

import { createHash } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Trim, drop zero-width characters, lowercase. Plus-tags and dots are kept,
// because they can be different mailboxes.
function normalizeEmail(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const address = email.replace(/[​-‍﻿]/g, '').trim().toLowerCase();
  if (address.length > 254 || !EMAIL_RE.test(address)) {
    throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  }
  return address;
}

function logPath(address) {
  const hash = createHash('sha256').update(address).digest('hex');
  return path.join(stateDir(), 'subs', `${hash}.jsonl`);
}

async function append(address, event) {
  const file = logPath(address);
  await mkdir(path.dirname(file), { recursive: true });
  // The leading newline keeps a torn line from a killed writer from
  // corrupting the record written after it.
  const record = `\n${JSON.stringify({ email: address, event, at: new Date().toISOString() })}\n`;
  const buf = Buffer.from(record);
  const fh = await open(file, 'a');
  try {
    let offset = 0;
    while (offset < buf.length) {
      const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
      offset += bytesWritten;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Returns 'subscribed', 'unsubscribed', or null when the address has no record.
async function marketingStatus(address) {
  let text;
  try {
    text = await readFile(logPath(address), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let status = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Partial line from a killed writer. That call never resolved, so the
      // caller retries and writes a complete record.
      continue;
    }
    if (rec.email !== address) continue;
    if (rec.event === 'unsubscribe') status = 'unsubscribed';
    else if (rec.event === 'resubscribe') status = 'subscribed';
  }
  return status;
}

export async function unsubscribe(email) {
  await append(normalizeEmail(email), 'unsubscribe');
}

export async function resubscribe(email) {
  await append(normalizeEmail(email), 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`kind must be "marketing" or "receipt", got ${JSON.stringify(kind)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  let address;
  try {
    address = normalizeEmail(email);
  } catch {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing was sent.' };
  }

  if (kind === 'receipt') {
    return { allowed: true, reason: 'Receipts are transactional and are not blocked by a marketing unsubscribe.' };
  }

  const status = await marketingStatus(address);
  if (status === 'subscribed') {
    return { allowed: true, reason: 'The address opted in to marketing email and has not unsubscribed since.' };
  }
  if (status === 'unsubscribed') {
    return { allowed: false, reason: 'This address unsubscribed from marketing email, so no newsletter or offer was sent.' };
  }
  return { allowed: false, reason: 'This address has no recorded opt-in for marketing email, so no newsletter or offer was sent.' };
}
