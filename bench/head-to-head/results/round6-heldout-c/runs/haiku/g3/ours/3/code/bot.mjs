// Email gate for newsletters (marketing) and receipts. Shared state lives in STATE_DIR,
// so every worker process on the machine sees the same unsubscribes.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 10;

// Lower-case and trim, so "  Ann@Example.COM " and "ann@example.com" are one person.
function normalize(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// Reads STATE_DIR on every call and creates the layout if it is missing.
async function locate(address) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await mkdir(join(dir, 'users'), { recursive: true });
  await mkdir(join(dir, 'locks'), { recursive: true });
  const key = createHash('sha256').update(address).digest('hex');
  return {
    file: join(dir, 'users', `${key}.json`),
    lock: join(dir, 'locks', key),
  };
}

// mkdir is atomic, so only one process holds the lock at a time. A lock older than
// LOCK_STALE_MS is left by a killed worker and is removed.
async function withLock(lockPath, fn) {
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readRecord(file, address) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { email: address, marketingOptOut: false, history: [] };
    }
    throw err;
  }
}

// Temp file then rename: a reader sees either the old record or the new one, never half of one.
async function writeRecord(file, record) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2));
  await rename(tmp, file);
}

async function setMarketingOptOut(email, optOut, action) {
  const address = normalize(email);
  if (!address) throw new TypeError(`${action} needs an email address`);
  const { file, lock } = await locate(address);
  return withLock(lock, async () => {
    const record = await readRecord(file, address);
    record.marketingOptOut = optOut;
    record.history.push({ action, at: new Date().toISOString() });
    await writeRecord(file, record);
    return { email: address, marketingOptOut: optOut };
  });
}

// Recipient clicked unsubscribe, replied STOP-style, or a one-click request arrived.
// Stops marketing mail only; receipts are transactional and still allowed.
export async function unsubscribe(email) {
  return setMarketingOptOut(email, true, 'unsubscribe');
}

// Only called when the person signs up again on the website, which is their own explicit
// request for marketing mail.
export async function resubscribe(email) {
  return setMarketingOptOut(email, false, 'resubscribe');
}

// Called before each email is handed to the mail provider. Fails closed: a missing address,
// an unknown kind or an unreadable record throws or refuses, and nothing is sent.
export async function mayEmail(email, kind, now) {
  const address = normalize(email);
  if (!address) {
    return { allowed: false, reason: 'There is no email address to send to.' };
  }
  if (kind !== 'marketing' && kind !== 'receipt') {
    return {
      allowed: false,
      reason: `The email kind "${kind}" is unknown; only "marketing" and "receipt" can be sent.`,
    };
  }
  const { file } = await locate(address);
  const record = await readRecord(file, address);
  if (kind === 'receipt') {
    return { allowed: true, reason: 'Receipts are allowed; an unsubscribe does not block transactional mail.' };
  }
  if (record.marketingOptOut) {
    return {
      allowed: false,
      reason: 'This address unsubscribed from marketing email, so no newsletter or offer is sent unless they sign up again on the website.',
    };
  }
  return { allowed: true, reason: 'Marketing email is allowed because this address has not unsubscribed.' };
}
