// Follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
// In-memory only: state is lost on process restart.
//
// Rules, checked in this order by check():
//   1. opted-out         customer sent a STOP keyword and has not sent START since
//   2. no-prior-inbound  customer has never written to us, so no proactive contact
//   3. outside-24h-window freeform text only inside 24h of the customer's last message
//      (templates are exempt from the window)

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Whole-message keywords only, as used by carriers (CTIA) and WhatsApp.
// Ordinary sentences that merely contain one of these words do not match.
const STOP_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
]);
const START_KEYWORDS = new Set(['start', 'unstop', 'yes']);

const TYPES = new Set(['freeform', 'template']);

/** @type {Map<string, { optedOut: boolean, lastInbound: number | null }>} */
const customers = new Map();

function getCustomer(userId) {
  let c = customers.get(userId);
  if (!c) {
    c = { optedOut: false, lastInbound: null };
    customers.set(userId, c);
  }
  return c;
}

// Trim spaces, punctuation and emoji around the word, ignore case and
// invisible characters, and collapse inner whitespace.
function normalize(text) {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * Record a message the customer sent to us.
 * @param {string} userId
 * @param {string} text raw message body as typed
 * @param {Date} at time the message was received
 */
export function onInbound(userId, text, at) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }

  const customer = getCustomer(userId);
  const word = normalize(text);

  if (STOP_KEYWORDS.has(word)) {
    customer.optedOut = true;
  } else if (customer.optedOut && START_KEYWORDS.has(word)) {
    customer.optedOut = false;
  }

  // Keep the latest inbound time, so out-of-order delivery cannot shrink the window.
  const ts = at.getTime();
  if (customer.lastInbound === null || ts > customer.lastInbound) {
    customer.lastInbound = ts;
  }
}

/**
 * Decide whether the assistant may send a follow-up now.
 * @param {string} userId
 * @param {'freeform' | 'template'} type
 * @param {Date} now
 * @returns {{ allowed: boolean, rule: string | null }}
 */
export function check(userId, type, now) {
  if (
    typeof userId !== 'string' || userId === '' ||
    !TYPES.has(type) ||
    !(now instanceof Date) || Number.isNaN(now.getTime())
  ) {
    return { allowed: false, rule: 'invalid-input' };
  }

  const customer = customers.get(userId);

  if (customer?.optedOut) {
    return { allowed: false, rule: 'opted-out' };
  }
  if (!customer || customer.lastInbound === null) {
    return { allowed: false, rule: 'no-prior-inbound' };
  }
  if (type === 'freeform' && now.getTime() - customer.lastInbound >= WINDOW_MS) {
    return { allowed: false, rule: 'outside-24h-window' };
  }
  return { allowed: true, rule: null };
}
