// Follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
//
// State is in memory only: it is lost on process restart. Callers must feed
// every inbound message through onInbound, and must ask check() before every
// assistant-initiated follow-up.
//
// Rules, in the order check() applies them:
//   invalid-user         userId is not a non-empty string (fail closed)
//   invalid-now          now is not a valid Date (fail closed)
//   unknown-type         type is neither "freeform" nor "template" (fail closed)
//   opted-out            customer sent a STOP keyword and has not sent START since
//   freeform-no-inbound  freeform text, customer has never written to us
//   freeform-window-closed  freeform text, more than 24h since last customer message
//   (none)               allowed
//
// Templates are allowed for customers who have never written to us, because
// they are the only message type the platform permits as a first contact.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Carrier opt-out keywords (CTIA list), matched against the whole message only.
const STOP_WORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit']);

// Opt-in keywords for starting again. YES is deliberately left out: it is
// also an ordinary answer to a question, so it must not silently re-enable messages.
const START_WORDS = new Set(['start', 'unstop']);

const customers = new Map(); // userId -> { optedOut: boolean, lastInboundMs: number | null }

// Lower-case the text and reduce it to its words: full-width letters are folded,
// zero-width characters are dropped, and any run of punctuation, symbols or
// whitespace becomes one space. Ends are trimmed. "  STOP!! " -> "stop".
// "I'll stop by" -> "i ll stop by", which is not a keyword.
function normalize(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isValidUserId(userId) {
  return typeof userId === 'string' && userId.length > 0;
}

function getOrCreate(userId) {
  let state = customers.get(userId);
  if (!state) {
    state = { optedOut: false, lastInboundMs: null };
    customers.set(userId, state);
  }
  return state;
}

export function onInbound(userId, text, at) {
  if (!isValidUserId(userId)) throw new TypeError('onInbound: userId must be a non-empty string');
  if (typeof text !== 'string') throw new TypeError('onInbound: text must be a string');
  if (!isValidDate(at)) throw new TypeError('onInbound: at must be a valid Date');

  const state = getOrCreate(userId);
  const word = normalize(text);

  // Opt state follows arrival order, so the last keyword received wins.
  if (STOP_WORDS.has(word)) state.optedOut = true;
  else if (START_WORDS.has(word)) state.optedOut = false;

  // Keep the newest timestamp, so a late-arriving older message cannot shorten the window.
  const atMs = at.getTime();
  if (state.lastInboundMs === null || atMs > state.lastInboundMs) state.lastInboundMs = atMs;
}

export function check(userId, type, now) {
  if (!isValidUserId(userId)) return { allowed: false, rule: 'invalid-user' };
  if (!isValidDate(now)) return { allowed: false, rule: 'invalid-now' };
  if (type !== 'freeform' && type !== 'template') return { allowed: false, rule: 'unknown-type' };

  const state = customers.get(userId);

  if (state?.optedOut) return { allowed: false, rule: 'opted-out' };

  if (type === 'template') return { allowed: true, rule: null };

  if (!state || state.lastInboundMs === null) {
    return { allowed: false, rule: 'freeform-no-inbound' };
  }

  if (now.getTime() - state.lastInboundMs >= WINDOW_MS) {
    return { allowed: false, rule: 'freeform-window-closed' };
  }

  return { allowed: true, rule: null };
}
