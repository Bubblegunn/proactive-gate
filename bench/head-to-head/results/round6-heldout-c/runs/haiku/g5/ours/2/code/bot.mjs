// Follow-up gate for the WhatsApp / SMS support assistant.
// State is in memory only: it is lost on restart and not shared between processes.

const DAY_MS = 24 * 60 * 60 * 1000;

// Carrier and WhatsApp opt-out words, matched against the whole message.
const OPT_OUT_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE',
  'OPT OUT', 'OPT-OUT', 'OPTOUT',
]);
// Words that turn messaging back on after an opt-out.
const OPT_IN_WORDS = new Set(['START', 'UNSTOP']);

// Upper-case, drop outer punctuation and collapse inner spaces, so "  Stop!! " becomes "STOP".
function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

// One record per user: seen = has ever written to us, lastInboundAt = latest valid inbound time (ms),
// optedOut = last opt-out / opt-in keyword decided the state.
const users = new Map();

function recordFor(userId) {
  const key = String(userId);
  let r = users.get(key);
  if (!r) {
    r = { seen: false, lastInboundAt: null, optedOut: false };
    users.set(key, r);
  }
  return r;
}

export function onInbound(userId, text, at) {
  const r = recordFor(userId);
  r.seen = true;

  // Opt-out handling does not depend on the timestamp, so it is applied even when `at` is invalid.
  const word = normalize(text);
  if (OPT_OUT_WORDS.has(word)) r.optedOut = true;
  else if (OPT_IN_WORDS.has(word)) r.optedOut = false;

  if (isValidDate(at) && (r.lastInboundAt === null || at.getTime() > r.lastInboundAt)) {
    r.lastInboundAt = at.getTime();
  }
}

function block(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  if (type !== 'freeform' && type !== 'template') return block('unknown_type');
  if (!isValidDate(now)) return block('invalid_now');

  const r = users.get(String(userId));

  // Opt-out beats every other rule.
  if (r?.optedOut) return block('opted_out');

  // Customers who never wrote to us have never been contacted by the assistant.
  if (!r?.seen) return block('no_inbound_history');

  // Free text is only allowed inside 24 hours of the customer's last message.
  // Templates are pre-approved and may be sent after that window.
  if (type === 'freeform') {
    const open = r.lastInboundAt !== null && now.getTime() - r.lastInboundAt < DAY_MS;
    if (!open) return block('outside_24h_window');
  }

  return { allowed: true, rule: null };
}
