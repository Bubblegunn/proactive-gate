// Suppression gate for newsletter (marketing) and receipt mail.
//
// Every worker on a machine shares only STATE_DIR, so all state lives there:
//   STATE_DIR/suppressed/<sha256 of address>.json  one file per opted-out address
//                                                  (file exists = no marketing mail)
//   STATE_DIR/tmp/                                 scratch space for atomic writes
//   STATE_DIR/audit.jsonl                          append-only log of every request
//
// Concurrency: a marker is created by hard-linking a fully written temp file, which
// fails with EEXIST if the marker already exists. Two workers can record the same
// unsubscribe at the same time and exactly one marker results. A killed worker can
// leave a temp file behind but never a half-written marker.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

// Unicode-normalise, trim and lower-case, so "  Anna@Example.COM " and
// "anna@example.com" are the same person. Returns null for an invalid address.
function normalize(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const s = email.normalize('NFKC').trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) return null;
  return s;
}

function markerPath(root, address) {
  const hash = createHash('sha256').update(address).digest('hex');
  return path.join(root, 'suppressed', `${hash}.json`);
}

async function ensureLayout(root) {
  await fs.mkdir(path.join(root, 'suppressed'), { recursive: true });
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
}

async function audit(root, record) {
  // One short line per call. O_APPEND keeps concurrent lines from interleaving.
  await fs.appendFile(path.join(root, 'audit.jsonl'), JSON.stringify(record) + '\n');
}

// Records that the address opted out of marketing mail. Idempotent: a repeat call
// keeps the original unsubscribe time.
export async function unsubscribe(email) {
  const root = stateDir();
  const address = normalize(email);
  if (!address) throw new TypeError('not a valid email address');
  await ensureLayout(root);

  const at = new Date().toISOString();
  const marker = markerPath(root, address);
  const tmp = path.join(root, 'tmp', `${process.pid}-${randomUUID()}`);
  let created;
  await fs.writeFile(tmp, JSON.stringify({ email: address, unsubscribedAt: at }) + '\n', {
    flag: 'wx',
  });
  try {
    await fs.link(tmp, marker);
    created = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    created = false;
  } finally {
    await fs.rm(tmp, { force: true });
  }
  // The marker is written before the audit line. If the worker dies between the two,
  // the opt-out still takes effect.
  await audit(root, { action: 'unsubscribe', email: address, at, created });
}

// Lifts the opt-out. Call only when the person signs up again on the website.
export async function resubscribe(email) {
  const root = stateDir();
  const address = normalize(email);
  if (!address) throw new TypeError('not a valid email address');
  await ensureLayout(root);

  const at = new Date().toISOString();
  await fs.rm(markerPath(root, address), { force: true });
  await audit(root, { action: 'resubscribe', email: address, at });
}

// Decides whether one email may be handed to the mail provider now.
// `now` is validated but does not change the decision: an opt-out must block mail
// even when the job carrying it was created before the opt-out arrived.
export async function mayEmail(email, kind, now) {
  const root = stateDir();
  if (!KINDS.has(kind)) throw new TypeError('kind must be "marketing" or "receipt"');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const address = normalize(email);
  if (!address) {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing can be sent to it.' };
  }

  if (kind === 'receipt') {
    // Order confirmations, shipping and password-reset mail are transactional, so
    // an unsubscribe from marketing does not block them.
    return { allowed: true, reason: 'Receipts are transactional mail, so they are allowed even after an unsubscribe.' };
  }

  let raw;
  try {
    raw = await fs.readFile(markerPath(root, address), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { allowed: true, reason: 'No unsubscribe is on record, so marketing mail may be sent.' };
    }
    throw err;
  }

  let when = '';
  try {
    const parsed = new Date(JSON.parse(raw).unsubscribedAt);
    if (!Number.isNaN(parsed.getTime())) when = ` on ${parsed.toISOString().slice(0, 10)}`;
  } catch {
    // Unreadable marker content still blocks marketing; only the date is lost.
  }
  return {
    allowed: false,
    reason: `Marketing mail is blocked: this address unsubscribed${when} and has not signed up again on the website.`,
  };
}
