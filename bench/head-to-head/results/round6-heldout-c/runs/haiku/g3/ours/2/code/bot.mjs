// Email consent gate for newsletters (marketing) and receipts (transactional).
// State lives in STATE_DIR and is shared by every worker process on the machine.
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns the normalised address, or null when it is not a usable address.
function normalise(email) {
  if (typeof email !== 'string') return null;
  const addr = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

function consentFile(addr) {
  const name = createHash('sha256').update(addr).digest('hex');
  return path.join(stateDir(), 'consent', `${name}.log`);
}

// One JSON line per event, appended with O_APPEND. Each record starts with a
// newline so a torn write from a killed worker cannot merge into the next record.
async function append(addr, action) {
  await mkdir(path.join(stateDir(), 'consent'), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), action, email: addr });
  await appendFile(consentFile(addr), `\n${line}\n`);
}

// The last readable event decides. An unreadable line counts as unsubscribed,
// so a damaged record can only hold marketing mail, never release it.
async function status(addr) {
  let text;
  try {
    text = await readFile(consentFile(addr), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'none', at: null };
    throw err;
  }
  let state = 'none';
  let at = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      state = 'unsubscribed';
      at = null;
      continue;
    }
    state = rec.action === 'resubscribe' ? 'subscribed' : 'unsubscribed';
    at = rec.at;
  }
  return { state, at };
}

export async function unsubscribe(email) {
  const addr = normalise(email);
  if (!addr) throw new TypeError('unsubscribe: email is not a valid address');
  await append(addr, 'unsubscribe');
}

// Call only when the person signs up again on the website. This also serves as
// the explicit marketing opt-in that mayEmail requires.
export async function resubscribe(email) {
  const addr = normalise(email);
  if (!addr) throw new TypeError('resubscribe: email is not a valid address');
  await append(addr, 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: `Not sent: unknown message kind "${kind}".` };
  }
  const addr = normalise(email);
  if (!addr) {
    return { allowed: false, reason: 'Not sent: the email address is not valid.' };
  }
  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Allowed: order, shipping and password-reset mail is transactional, so the marketing opt-out does not block it.',
    };
  }
  const { state, at } = await status(addr);
  if (state === 'unsubscribed') {
    const when = at ? ` on ${at}` : '';
    return {
      allowed: false,
      reason: `Not sent: this address unsubscribed from marketing email${when}. It stays off until the person signs up again on the website.`,
    };
  }
  if (state === 'none') {
    return {
      allowed: false,
      reason: 'Not sent: there is no explicit marketing opt-in on record for this address, and EU rules require one.',
    };
  }
  return { allowed: true, reason: 'Allowed: this address opted in to marketing email and has not unsubscribed.' };
}
