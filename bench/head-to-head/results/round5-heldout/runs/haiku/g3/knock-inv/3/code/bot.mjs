// Email suppression for the shop's marketing sends.
//
// Shared state lives in STATE_DIR/suppression/<sha256 of normalized address>.ndjson.
// Each unsubscribe or resubscribe is one appended line. Appends are atomic across
// processes, so no lock is needed. The current state is the latest timestamp of
// each kind, so the order in which events arrive does not matter.
//
// Rules:
// - Marketing mail stops after an unsubscribe. A later resubscribe (by provider
//   clock) turns marketing back on. Ties go to the unsubscribe.
// - Transactional mail (order receipts, password resets) is never blocked by
//   marketing opt-out. CAN-SPAM covers commercial messages, not transactional ones.
// - Anything that cannot be verified is denied. A bad address, an unknown kind,
//   or unreadable state all stop the send.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'transactional']);
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Reduce an address to the mailbox owner: strip a display name and angle brackets,
// lowercase, drop +tag aliases, and treat Gmail's dot and googlemail.com variants
// as the same account. Returns null if the input is not a usable address.
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').toLowerCase();
  if (/\s/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (!domain.includes('.') || domain.includes('@')) return null;
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  local = local.split('+')[0];
  if (!local) return null;
  return `${local}@${domain}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'suppression');
}

function eventFile(address) {
  const digest = createHash('sha256').update(address).digest('hex');
  return path.join(stateDir(), `${digest}.ndjson`);
}

async function appendEvent(address, kind, at) {
  await mkdir(stateDir(), { recursive: true });
  const handle = await open(eventFile(address), 'a');
  try {
    // The leading newline ends any partial line left by a crash, so it cannot
    // swallow this record. Blank and unparseable lines are skipped when reading.
    await handle.write(`\n${JSON.stringify({ k: kind, t: at.getTime() })}\n`);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function readState(address) {
  let text;
  try {
    text = await readFile(eventFile(address), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsubAt: null, resubAt: null };
    throw err;
  }
  let unsubAt = null;
  let resubAt = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isFinite(event?.t)) continue;
    if (event.k === 'u') unsubAt = Math.max(unsubAt ?? event.t, event.t);
    else if (event.k === 'r') resubAt = Math.max(resubAt ?? event.t, event.t);
  }
  return { unsubAt, resubAt };
}

function isMarketingOptedOut({ unsubAt, resubAt }) {
  return unsubAt !== null && (resubAt === null || unsubAt >= resubAt);
}

function checkEventArgs(email, at) {
  const address = normalizeAddress(email);
  if (!address) throw new TypeError(`invalid email address: ${String(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  return address;
}

export async function recordUnsubscribe(email, at) {
  const address = checkEventArgs(email, at);
  await appendEvent(address, 'u', at);
}

export async function recordResubscribe(email, at) {
  const address = checkEventArgs(email, at);
  await appendEvent(address, 'r', at);
}

const allow = () => ({ allowed: true, reason: null });
const deny = (reason) => ({ allowed: false, reason });

// `now` is accepted for the interface. None of the rules depend on it: an opt-out
// applies from the moment it is recorded, whatever the clock says.
export async function mayEmail(message, now) { // eslint-disable-line no-unused-vars
  if (!message || !KINDS.has(message.kind)) return deny('invalid_kind');
  const address = normalizeAddress(message.to);
  if (!address) return deny('invalid_recipient');
  if (message.kind === 'transactional') return allow();

  let state;
  try {
    state = await readState(address);
  } catch {
    return deny('suppression_state_unavailable');
  }
  if (isMarketingOptedOut(state)) return deny('unsubscribed');
  return allow();
}
