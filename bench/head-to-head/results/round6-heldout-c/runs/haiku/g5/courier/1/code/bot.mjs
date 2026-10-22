// Follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
// All state is in memory and is lost on restart.

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole-message keywords only. Matched after normalize(), so "Stop!", " stop "
// and "STOP." count, while "my bus stop is far" is ordinary conversation.
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN_WORDS = new Set(['start', 'unstop']);

const lastInboundMs = new Map(); // userId -> latest customer message time (ms)
const optedOut = new Set(); // userIds whose last opt keyword was an opt-out

function assertDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

// Reduce a message to the bare keyword candidate: Unicode-normalize (full-width
// letters etc.), drop invisible characters, collapse whitespace, strip
// punctuation/symbols/spaces at both ends, lower-case.
function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .toLowerCase();
}

export function onInbound(userId, text, at) {
  assertDate(at, 'at');

  const ms = at.getTime();
  const previous = lastInboundMs.get(userId);
  if (previous === undefined || ms > previous) {
    lastInboundMs.set(userId, ms);
  }

  if (typeof text !== 'string') return;

  const word = normalize(text);
  if (OPT_OUT_WORDS.has(word)) {
    optedOut.add(userId);
  } else if (OPT_IN_WORDS.has(word)) {
    optedOut.delete(userId);
  }
}

export function check(userId, type, now) {
  assertDate(now, 'now');
  if (type !== 'freeform' && type !== 'template') {
    throw new TypeError(`type must be "freeform" or "template", got ${String(type)}`);
  }

  if (optedOut.has(userId)) {
    return { allowed: false, rule: 'opted-out' };
  }

  // Free text is only allowed inside the 24-hour window that opens with the
  // customer's last message. Customers who never wrote to us have no window.
  // Pre-approved templates are the route for business-initiated messages.
  if (type === 'freeform') {
    const last = lastInboundMs.get(userId);
    if (last === undefined || now.getTime() - last >= DAY_MS) {
      return { allowed: false, rule: 'freeform-outside-24h-window' };
    }
  }

  return { allowed: true, rule: null };
}
