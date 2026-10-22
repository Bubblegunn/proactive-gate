import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// One immutable file per event under STATE_DIR/optout/<hash of address>/.
// Files are created by temp-file + rename, so two workers never overwrite each other
// and no read-modify-write race exists. The decision is computed from all events.

function normalize(email) {
  let s = String(email ?? '').trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, '').replace(/^["'\s]+|["'\s]+$/g, '');
  return s.toLowerCase();
}

function dirFor(email) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error('STATE_DIR is not set');
  const h = createHash('sha256').update(normalize(email)).digest('hex');
  return join(base, 'optout', h);
}

function write(email, type, ms) {
  const dir = dirFor(email);
  mkdirSync(dir, { recursive: true });
  const id = `${String(ms).padStart(16, '0')}-${type}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmp = join(dir, `.tmp-${id}`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, JSON.stringify({ email: normalize(email), type, at: ms }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, `ev-${id}`));
}

export function recordUnsubscribe(email, at) {
  let ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  // Unknown time: assume now, so the opt-out is never lost.
  if (!Number.isFinite(ms)) ms = Date.now();
  write(email, 'unsub', ms);
}

export function recordResubscribe(email, at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) throw new Error('recordResubscribe: invalid date');
  write(email, 'resub', ms);
}

function state(email) {
  let unsub = -Infinity, resub = -Infinity;
  let names;
  try {
    names = readdirSync(dirFor(email));
  } catch (e) {
    if (e.code === 'ENOENT') return { unsub, resub };
    throw e;
  }
  for (const n of names) {
    const m = n.match(/^ev-(\d+)-(unsub|resub)-/);
    if (!m) continue;
    const ms = Number(m[1]);
    if (m[2] === 'unsub') unsub = Math.max(unsub, ms);
    else resub = Math.max(resub, ms);
  }
  return { unsub, resub };
}

export function mayEmail(message, now) {
  // Receipts, password resets and other transactional mail are exempt from opt-outs.
  if (message?.kind === 'transactional') return { allowed: true, reason: null };
  // Anything else (marketing, agent "we miss you" mail) must honour the opt-out.
  const { unsub, resub } = state(message?.to);
  // The latest event by provider time wins; on a tie the unsubscribe wins.
  if (unsub !== -Infinity && !(resub > unsub)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
