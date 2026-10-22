// Email opt-out gate for the shop's marketing and transactional mail.
// State lives in STATE_DIR so every worker process and every restart sees the same opt-outs.
//
// Rules:
// - Marketing mail is blocked while the latest unsubscribe for the person is not superseded
//   by a later resubscribe. Ties go to the unsubscribe (safer).
// - Transactional mail (order receipts, password resets) is never blocked by an opt-out.
// - Unknown kinds, invalid addresses and unreadable state are refused (fail closed for marketing).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'transactional']);

const refuse = (reason) => ({ allowed: false, reason });

// One person, many addresses: case, display names ("Name <a@b.c>"), +tags and,
// for Gmail, dots and googlemail.com all point to the same mailbox.
// Matching broadly is the safe direction for opt-outs.
function canonicalAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  const angle = /<([^<>]*)>/.exec(s);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  const m = /^([^\s@<>",;:]+)@([^\s@<>",;:]+)$/.exec(s);
  if (!m || !m[2].includes('.')) return null;
  let [, local, domain] = m;
  domain = domain.replace(/\.$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  if (!local) return null;
  return `${local}@${domain}`;
}

const keyOf = (canon) => createHash('sha256').update(canon).digest('hex');

function optOutRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'optouts');
}

async function recordEvent(type, email, at) {
  const canon = canonicalAddress(email);
  if (!canon) throw new TypeError('email is not a valid address');
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('at must be a valid Date');

  const dir = path.join(optOutRoot(), keyOf(canon));
  await mkdir(dir, { recursive: true });

  // Deterministic name: a redelivered event rewrites the same file with the same content.
  // Write to a unique temp file, fsync, then rename, so readers never see a partial file.
  const atMs = at.getTime();
  const file = path.join(dir, `${type}-${atMs}.json`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(JSON.stringify({ type, at: atMs }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

async function eventsFor(canon) {
  const dir = path.join(optOutRoot(), keyOf(canon));
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const ev = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    if ((ev.type !== 'unsubscribe' && ev.type !== 'resubscribe') || !Number.isFinite(ev.at)) {
      throw new Error(`malformed opt-out record: ${name}`);
    }
    events.push(ev);
  }
  return events;
}

// Latest event by provider clock wins. Out-of-order arrival does not matter because
// the comparison uses the event time, not the arrival order.
function isOptedOut(events) {
  let unsub = -Infinity;
  let resub = -Infinity;
  for (const e of events) {
    if (e.type === 'unsubscribe') unsub = Math.max(unsub, e.at);
    else resub = Math.max(resub, e.at);
  }
  return unsub > -Infinity && resub <= unsub;
}

export async function recordUnsubscribe(email, at) {
  await recordEvent('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await recordEvent('resubscribe', email, at);
}

export async function mayEmail(message, now) {
  const to = canonicalAddress(message?.to);
  if (!to) return refuse('invalid_recipient');
  if (!KINDS.has(message.kind)) return refuse('unknown_kind');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return refuse('invalid_now');

  // Transactional mail (receipts, password resets) is expected by the customer after an
  // unsubscribe, so it is not checked against opt-outs.
  if (message.kind === 'transactional') return { allowed: true, reason: null };

  try {
    if (isOptedOut(await eventsFor(to))) return refuse('unsubscribed');
  } catch {
    return refuse('opt_out_state_unavailable');
  }
  return { allowed: true, reason: null };
}
