// In-memory follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
// The assistant calls onInbound for every customer message and check before any follow-up.
// Nothing here sends a message; check only answers whether a send would be allowed.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Opt-out keywords from the standard carrier list (CTIA).
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
// Opt-in keywords. YES is left out on purpose: a bare "yes" is a common reply to unrelated questions.
const START_WORDS = new Set(['START', 'UNSTOP']);

// userId -> { lastInboundAt: epoch ms | null, optedOut: boolean }
const customers = new Map();

// Reduces a message to the bare keyword it may contain, or null.
// The whole message must be the keyword: "please stop" or "stop calling" are normal conversation.
function keywordOf(text) {
  if (typeof text !== 'string') return null;
  return text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function customerFor(userId) {
  let customer = customers.get(userId);
  if (!customer) {
    customer = { lastInboundAt: null, optedOut: false };
    customers.set(userId, customer);
  }
  return customer;
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function onInbound(userId, text, at) {
  const customer = customerFor(userId);

  const word = keywordOf(text);
  if (STOP_WORDS.has(word)) {
    customer.optedOut = true;
  } else if (START_WORDS.has(word)) {
    customer.optedOut = false;
  }

  // Keep the latest inbound time, even if messages arrive out of order.
  // An invalid timestamp is skipped; the older value keeps the 24h window narrower, which is the safe side.
  if (isValidDate(at)) {
    const t = at.getTime();
    if (customer.lastInboundAt === null || t > customer.lastInboundAt) {
      customer.lastInboundAt = t;
    }
  }
}

function block(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  // Unknown types fail closed.
  if (type !== 'freeform' && type !== 'template') return block('unknown-type');
  if (!isValidDate(now)) return block('invalid-time');

  const customer = customers.get(userId);

  // Applies to every message type. Opt-out holds until the customer sends START or UNSTOP.
  if (customer?.optedOut) return block('opted-out');

  // Customers who never wrote to us have no conversation and no opt-in on record.
  if (!customer || customer.lastInboundAt === null) return block('no-prior-inbound');

  // Free text is only allowed inside the 24-hour customer-service window that starts with the customer's last message.
  // Pre-approved templates are not limited by this window.
  if (type === 'freeform' && now.getTime() - customer.lastInboundAt >= WINDOW_MS) {
    return block('freeform-window-closed');
  }

  return { allowed: true, rule: null };
}
