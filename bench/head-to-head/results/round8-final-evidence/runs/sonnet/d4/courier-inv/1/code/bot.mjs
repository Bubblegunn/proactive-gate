import fs from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const FILE_NAME = 'suppressions.log';
const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);

// Different spellings of one address must map to one key.
// Handles: surrounding whitespace, "Name <a@b>", mailto:, case, IDN domains,
// trailing dot in the domain, "+tag" in the local part, Gmail dots/googlemail.
// Returns { exact, base } or null when the address cannot be parsed.
// base drops the "+tag"; exact keeps it (except on Gmail, where tags and
// dots never identify a different mailbox).
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').trim();
  s = s.replace(/^mailto:/i, '').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  const q = s.indexOf('?');
  if (q !== -1 && /^mailto:/i.test(raw.trim())) s = s.slice(0, q);
  if (/[\s\u0000-\u001f<>,;"()\\]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = domainToASCII(s.slice(at + 1).replace(/\.+$/, '').toLowerCase());
  if (!domain || !domain.includes('.')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  const noTag = plus === -1 ? local : local.slice(0, plus);
  if (!noTag) return null;
  if (domain === 'gmail.com') {
    const g = noTag.replace(/\./g, '');
    if (!g) return null;
    return { exact: `${g}@${domain}`, base: `${g}@${domain}` };
  }
  return { exact: `${local}@${domain}`, base: `${noTag}@${domain}` };
}

function stateFile() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return { dir, file: path.join(dir, FILE_NAME) };
}

// Each event is one JSON line written with a single O_APPEND write, so
// concurrent writers in several processes do not interleave.
async function appendLine(line) {
  const { dir, file } = stateFile();
  await fs.promises.mkdir(dir, { recursive: true });
  const fh = await fs.promises.open(file, 'a');
  try {
    await fh.write(Buffer.from(line, 'utf8'));
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// Reads the whole log on every check so events written by other processes
// are always seen. Unparseable lines (e.g. a torn last line) are skipped.
async function loadState() {
  const { file } = stateFile();
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') text = '';
    else throw e;
  }
  const state = { unsub: new Set(), spam: new Set(), bounce: new Set() };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev.b !== 'string') continue;
    if (ev.t === 'unsubscribe') state.unsub.add(ev.b);
    else if (ev.t === 'spam_complaint') state.spam.add(ev.b);
    else if (ev.t === 'hard_bounce' && typeof ev.e === 'string') state.bounce.add(ev.e);
  }
  return state;
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${type}`);
  const n = normalize(email);
  if (!n) throw new TypeError(`invalid email address: ${email}`);
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;
  await appendLine(JSON.stringify({ t: type, e: n.exact, b: n.base, at }) + '\n');
}

// Policy:
//  - hard_bounce blocks all mail (the mailbox does not exist; sending hurts reputation).
//  - unsubscribe and spam_complaint block marketing at once (CAN-SPAM allows 10
//    business days; we do not wait). Transactional mail the person needs is
//    still allowed, as CAN-SPAM exempts it.
//  - Unparseable addresses and unknown kinds are refused (fail closed).
export async function checkEmail({ email, kind, now } = {}) {
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, rule: 'unknown_kind' };
  }
  const n = normalize(email);
  if (!n) return { allowed: false, rule: 'invalid_address' };
  const s = await loadState();
  if (s.bounce.has(n.exact)) return { allowed: false, rule: 'hard_bounce' };
  if (kind === 'marketing') {
    if (s.spam.has(n.base)) return { allowed: false, rule: 'spam_complaint' };
    if (s.unsub.has(n.base)) return { allowed: false, rule: 'unsubscribed' };
  }
  return { allowed: true, rule: '' };
}
