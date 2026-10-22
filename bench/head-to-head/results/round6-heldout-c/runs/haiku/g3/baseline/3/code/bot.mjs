// Send gate for marketing and receipt email, shared by several worker processes.
// All state lives under STATE_DIR. Each unsubscribe or resubscribe is written as
// one immutable event file (temp file, fsync, atomic rename), so workers never
// read-modify-write the same file and no lock is needed.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EVENT_FILE = /^(\d{15})-[0-9a-f-]{36}-(unsubscribe|resubscribe)\.json$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

// Trims stray spaces, applies Unicode NFKC and lowercases. Returns null if the
// result does not look like an address.
function normaliseEmail(email) {
  if (typeof email !== 'string') return null;
  const s = email.normalize('NFKC').trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function requireAddress(email) {
  const addr = normaliseEmail(email);
  if (!addr) throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  return addr;
}

function emailDir(addr) {
  const hash = createHash('sha256').update(addr).digest('hex');
  return path.join(stateDir(), 'suppression', hash);
}

async function recordEvent(addr, event) {
  const dir = emailDir(addr);
  await fs.mkdir(dir, { recursive: true });
  const ts = Date.now();
  // Zero-padded timestamp first, so the file name carries the time.
  const name = `${String(ts).padStart(15, '0')}-${randomUUID()}-${event}.json`;
  // Temp names start with "." so readers skip them until the rename.
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ email: addr, event, at: new Date(ts).toISOString() }) + '\n');
    await handle.sync();
  } catch (err) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  await fs.rename(tmp, path.join(dir, name));
  // Sync the directory so the rename itself survives a power loss.
  const dirHandle = await fs.open(dir, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

// An address is suppressed for marketing when its newest unsubscribe is not
// followed by a resubscribe. A resubscribe must be strictly later to clear it;
// on an exact millisecond tie the opt-out wins.
async function marketingSuppression(addr) {
  let names;
  try {
    names = await fs.readdir(emailDir(addr));
  } catch (err) {
    if (err.code === 'ENOENT') return { suppressed: false };
    throw err;
  }
  let lastUnsubscribe = -1;
  let lastResubscribe = -1;
  for (const name of names) {
    const m = EVENT_FILE.exec(name);
    if (!m) continue;
    const ts = Number(m[1]);
    if (m[2] === 'unsubscribe') lastUnsubscribe = Math.max(lastUnsubscribe, ts);
    else lastResubscribe = Math.max(lastResubscribe, ts);
  }
  const suppressed = lastUnsubscribe >= 0 && !(lastResubscribe > lastUnsubscribe);
  return { suppressed, since: lastUnsubscribe };
}

// Called on an unsubscribe link click, an unsubscribe reply, or a one-click
// unsubscribe request. Throws TypeError for a malformed address.
export async function unsubscribe(email) {
  await recordEvent(requireAddress(email), 'unsubscribe');
}

// Called only when the person deliberately signs up again on the website.
export async function resubscribe(email) {
  await recordEvent(requireAddress(email), 'resubscribe');
}

// Resolves to { allowed, reason }. The reason is one short sentence for support staff.
// Suppression is checked against every recorded event, not against `now`: a
// queued job with an old timestamp must still honour an opt-out recorded later.
// `now` is validated only.
export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`kind must be "marketing" or "receipt", got ${JSON.stringify(kind)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const addr = normaliseEmail(email);
  if (!addr) {
    return { allowed: false, reason: 'The address is missing or malformed, so the email cannot be delivered.' };
  }
  if (kind === 'receipt') {
    return { allowed: true, reason: 'Order and account emails are transactional, so an unsubscribe does not block them.' };
  }
  const { suppressed, since } = await marketingSuppression(addr);
  if (suppressed) {
    const day = new Date(since).toISOString().slice(0, 10);
    return {
      allowed: false,
      reason: `This address unsubscribed from marketing email on ${day} and has not signed up again, so no newsletter or offer can be sent.`,
    };
  }
  return { allowed: true, reason: 'No unsubscribe is on record for this address, so marketing email is allowed.' };
}
