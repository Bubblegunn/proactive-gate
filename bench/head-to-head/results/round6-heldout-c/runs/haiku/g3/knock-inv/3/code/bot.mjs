// Email suppression state shared by all workers through STATE_DIR.
//
// Layout: STATE_DIR/optout/<sha256 of normalized address>.jsonl
// Each record is appended as "\n{json}". Appends use O_APPEND and are fsynced
// before unsubscribe()/resubscribe() resolve, so a record that was acknowledged
// survives a worker kill. The last unsubscribe/resubscribe record in a file
// decides the state. A torn line from a killed writer is skipped; its call was
// never acknowledged, so the caller retries it.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Checkout forms and mail clients add case and stray spaces. Lowercasing the
// whole address is a practical choice; it can in theory merge two mailboxes
// whose local parts differ only by case.
function normalize(email) {
  if (typeof email !== 'string') return null;
  const addr = email.trim().toLowerCase();
  return EMAIL_RE.test(addr) ? addr : null;
}

function logPath(addr) {
  const hash = createHash('sha256').update(addr).digest('hex');
  return path.join(stateDir(), 'optout', `${hash}.jsonl`);
}

async function append(addr, type) {
  const file = logPath(addr);
  await mkdir(path.dirname(file), { recursive: true });
  const record = { type, email: addr, at: new Date().toISOString() };
  const fh = await open(file, 'a');
  try {
    await fh.writeFile('\n' + JSON.stringify(record));
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function records(addr) {
  let text;
  try {
    text = await readFile(logPath(addr), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Torn line from a killed writer. That call was never acknowledged.
    }
  }
  return out;
}

function currentOptState(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const type = list[i].type;
    if (type === 'unsubscribe' || type === 'resubscribe') return list[i];
  }
  return null;
}

function deny(reason) {
  return { allowed: false, reason };
}

export async function unsubscribe(email) {
  const addr = normalize(email);
  if (!addr) throw new TypeError('unsubscribe: not a valid email address');
  await append(addr, 'unsubscribe');
}

// Call only when the person signs up again on the website themselves.
export async function resubscribe(email) {
  const addr = normalize(email);
  if (!addr) throw new TypeError('resubscribe: not a valid email address');
  await append(addr, 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  const addr = normalize(email);
  if (!addr) {
    return deny('The address is missing or malformed, so the email was not sent.');
  }
  if (!KINDS.has(kind)) {
    return deny(`Unknown email kind "${kind}"; use "marketing" or "receipt".`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny('No valid send time was given, so the email was not sent.');
  }

  let last;
  try {
    last = currentOptState(await records(addr));
  } catch {
    // Fail closed: if the suppression record cannot be read, nothing is sent.
    return deny('The suppression record could not be read, so the email was held. Retry later.');
  }
  const optedOut = last?.type === 'unsubscribe';

  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: optedOut
        ? 'Receipt email (order, shipping or password reset) is allowed: the customer unsubscribed from marketing only.'
        : 'Receipt email is allowed: no unsubscribe is on record.',
    };
  }

  if (optedOut) {
    return deny(
      `The customer unsubscribed from marketing emails on ${last.at}, so newsletters and offers are not sent until they sign up again on the website.`,
    );
  }
  return { allowed: true, reason: 'Marketing email is allowed: no unsubscribe is on record.' };
}
