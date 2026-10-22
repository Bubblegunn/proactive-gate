// Email consent and suppression state, shared by all worker processes through STATE_DIR.
//
// Layout: STATE_DIR/consent/<sha256 of normalized address>/<ms>-<uuid>.json
// Every change is one new file, written to a temp name, fsynced and renamed into place,
// so a worker that is killed mid-write leaves no partial record and no lock to clean up.
//
// Rules:
// - marketing (newsletters, offers): allowed only while the address is opted in. Opt-in is
//   the latest resubscribe, and it must be later than the latest unsubscribe. A tie counts as
//   unsubscribed. An address never opted in is blocked (EU/PECR and GDPR need prior consent).
// - receipt (order, shipping, password reset): transactional, so allowed for any valid address.
//   An unsubscribe from marketing does not block it.
// - Fail closed: an unknown kind or an invalid address returns allowed: false. Corrupt state
//   throws, so the caller does not send.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function emailDir(email) {
  const hash = createHash('sha256').update(email).digest('hex');
  return join(stateDir(), 'consent', hash);
}

async function record(email, action) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError(`Not a valid email address: ${String(email)}`);

  const dir = emailDir(e);
  await mkdir(dir, { recursive: true });

  const at = Date.now();
  const body = JSON.stringify({ email: e, action, at, atIso: new Date(at).toISOString() }) + '\n';
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, `${at}-${randomUUID()}.json`));
}

async function latestActions(email) {
  const dir = emailDir(email);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { lastUnsub: null, lastSub: null };
    throw err;
  }

  let lastUnsub = null;
  let lastSub = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const ev = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (ev.action === 'unsubscribe') lastUnsub = Math.max(lastUnsub ?? -Infinity, ev.at);
    else if (ev.action === 'resubscribe') lastSub = Math.max(lastSub ?? -Infinity, ev.at);
  }
  return { lastUnsub, lastSub };
}

export async function unsubscribe(email) {
  await record(email, 'unsubscribe');
}

export async function resubscribe(email) {
  await record(email, 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: `Unknown email kind "${String(kind)}", so nothing was sent.` };
  }

  const e = normalizeEmail(email);
  if (!e) {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing was sent.' };
  }

  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Receipts (orders, shipping, password resets) are transactional and are not blocked by a marketing unsubscribe.',
    };
  }

  // The state is read from disk on every call, so a worker started after a
  // record was written sees it. Records are honored whatever their timestamp.
  const { lastUnsub, lastSub } = await latestActions(e);
  const optedIn = lastSub !== null && (lastUnsub === null || lastSub > lastUnsub);
  if (optedIn) {
    return { allowed: true, reason: 'The recipient opted in to marketing email and has not unsubscribed since.' };
  }
  if (lastUnsub !== null) {
    return {
      allowed: false,
      reason: 'The recipient unsubscribed from marketing email and has not signed up again, so no newsletter or offer was sent.',
    };
  }
  return {
    allowed: false,
    reason: 'The recipient has never opted in to marketing email, so no newsletter or offer was sent.',
  };
}
