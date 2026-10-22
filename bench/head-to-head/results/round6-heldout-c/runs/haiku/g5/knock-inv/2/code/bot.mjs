// Consent and window gate for the assistant's own follow-up messages.
// State lives in memory only; it is lost on process restart.

// Opt-out and opt-in keywords follow the usual carrier/CTIA text-program convention.
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP', 'YES']);

// WhatsApp customer-service window: free text is allowed only within 24h of the customer's last message.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// userId -> { lastInboundMs: number | null, optedOut: boolean }
const customers = new Map();

// Reduce a raw message to a keyword candidate: trim whitespace, punctuation, symbols and
// invisible format characters from both ends, then compare case-insensitively.
// Internal words are kept, so "stop by the store" is not a keyword.
function keywordOf(text) {
  if (typeof text !== 'string') return null;
  return text
    .normalize('NFKC')
    .replace(/^[\s\p{P}\p{S}\p{Cf}]+|[\s\p{P}\p{S}\p{Cf}]+$/gu, '')
    .toUpperCase();
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function onInbound(userId, text, at) {
  if (!isValidDate(at)) {
    throw new TypeError('onInbound: at must be a valid Date');
  }

  let customer = customers.get(userId);
  if (!customer) {
    customer = { lastInboundMs: null, optedOut: false };
    customers.set(userId, customer);
  }

  const ms = at.getTime();
  customer.lastInboundMs = customer.lastInboundMs === null ? ms : Math.max(customer.lastInboundMs, ms);

  const keyword = keywordOf(text);
  if (OPT_OUT_KEYWORDS.has(keyword)) {
    customer.optedOut = true;
  } else if (OPT_IN_KEYWORDS.has(keyword)) {
    customer.optedOut = false;
  }
}

function blocked(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  // Fail closed on anything we do not understand.
  if (type !== 'freeform' && type !== 'template') return blocked('invalid_type');
  if (!isValidDate(now)) return blocked('invalid_time');

  const customer = customers.get(userId);

  if (customer?.optedOut) return blocked('opted_out');
  if (!customer || customer.lastInboundMs === null) return blocked('no_prior_inbound');
  if (type === 'freeform' && now.getTime() - customer.lastInboundMs >= WINDOW_MS) {
    return blocked('freeform_window_closed');
  }

  return { allowed: true, rule: null };
}
