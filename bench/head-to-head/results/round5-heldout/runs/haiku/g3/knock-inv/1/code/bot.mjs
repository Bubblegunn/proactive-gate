// Suppression rules for the shop's email queue and the "we miss you" agent.
//
// State lives in $STATE_DIR/suppression/. Each email key gets its own
// append-only JSONL file. Every worker appends with O_APPEND and fsyncs, and
// every check re-reads the file, so all workers see the same history and a
// restart loses nothing. Events are max-merged by the provider's timestamp,
// so arrival order does not matter.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function suppressionDir() {
  const base = process.env.STATE_DIR;
  if (!base) {
    throw new Error('STATE_DIR must be set so all workers share suppression state');
  }
  return join(base, 'suppression');
}

// Maps an address, or a header value such as `"Jane" <<EMAIL>>`,
// to one key per person. The +tag is dropped for every domain: when in doubt,
// an opt-out covers more addresses, not fewer. Gmail also ignores dots and
// treats googlemail.com as gmail.com, so those are folded too.
// Returns null when the input is not an address.
function suppressionKey(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').trim();
  const angle = s.match(/<([^<>]+)>/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  if (!ADDRESS_RE.test(s)) return null;

  const at = s.lastIndexOf('@');
  let local = s.slice(0, at).split('+')[0];
  let domain = s.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

function fileFor(dir, key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(dir, `${hash}.jsonl`);
}

async function appendEvent(kind, email, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  const key = suppressionKey(email);
  if (!key) throw new TypeError(`not an email address: ${String(email)}`);

  const dir = suppressionDir();
  await mkdir(dir, { recursive: true });

  // A leading newline keeps a line torn by a crash from swallowing the next
  // event. Readers skip any line that does not parse.
  const line = '\n' + JSON.stringify({ id: randomUUID(), kind, key, at: at.getTime() });
  const handle = await open(fileFor(dir, key), 'a');
  try {
    await handle.appendFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readEvents(key) {
  let text;
  try {
    text = await readFile(fileFor(suppressionDir(), key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      ev.key === key &&
      (ev.kind === 'unsubscribe' || ev.kind === 'resubscribe') &&
      Number.isFinite(ev.at)
    ) {
      events.push(ev);
    }
  }
  return events;
}

function latestAt(events, kind) {
  let max = null;
  for (const ev of events) {
    if (ev.kind === kind && (max === null || ev.at > max)) max = ev.at;
  }
  return max;
}

export async function recordUnsubscribe(email, at) {
  await appendEvent('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await appendEvent('resubscribe', email, at);
}

// Rules, in order:
// 1. Malformed recipient -> never send.
// 2. Transactional (receipts, password resets) -> always send. An opt-out
//    from marketing does not stop mail the person needs to receive.
// 3. Marketing -> blocked if the latest unsubscribe is not followed by a
//    strictly later resubscribe. A tie counts as unsubscribed.
// Unknown kinds are denied. A storage error throws, so the queue retries
// and nothing is sent without a readable suppression state.
// `now` is validated but not used: opt-outs take effect as soon as they are
// recorded, so the decision does not depend on the current time.
export async function mayEmail(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const deny = (reason) => ({ allowed: false, reason });
  const allow = () => ({ allowed: true, reason: null });

  const key = suppressionKey(message?.to);
  if (!key) return deny('invalid_recipient');
  if (message.kind === 'transactional') return allow();
  if (message.kind !== 'marketing') return deny('unknown_kind');

  const events = await readEvents(key);
  const unsubscribedAt = latestAt(events, 'unsubscribe');
  const resubscribedAt = latestAt(events, 'resubscribe');
  const unsubscribed =
    unsubscribedAt !== null && (resubscribedAt === null || resubscribedAt <= unsubscribedAt);
  if (unsubscribed) return deny('unsubscribed');
  return allow();
}
