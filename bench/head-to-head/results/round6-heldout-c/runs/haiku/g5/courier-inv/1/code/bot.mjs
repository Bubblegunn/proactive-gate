// Follow-up gate for WhatsApp Business and SMS. In-memory state only.
// onInbound records each customer message. check decides whether the assistant may send a follow-up.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Standard opt-out and opt-in keywords for SMS and WhatsApp programs.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop"]);

// Reduce a message to letters and digits, lowercased, so "STOP!", " stop. " and "S-T-O-P" compare equal.
// Only the whole message counts as a keyword; "stop by the store" is normal conversation.
function keyword(text) {
  if (typeof text !== "string") return "";
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// userId -> { lastInboundAt: ms since epoch, optedOut: boolean }
const customers = new Map();

export function onInbound(userId, text, at) {
  const atMs = at.getTime();
  const customer = customers.get(userId) ?? { lastInboundAt: -Infinity, optedOut: false };

  // Keep the latest inbound time, in case messages arrive out of order.
  customer.lastInboundAt = Math.max(customer.lastInboundAt, atMs);

  const word = keyword(text);
  if (STOP_WORDS.has(word)) customer.optedOut = true;
  else if (START_WORDS.has(word)) customer.optedOut = false;

  customers.set(userId, customer);
}

export function check(userId, type, now) {
  if (type !== "freeform" && type !== "template") {
    return { allowed: false, rule: "invalid-type" };
  }

  const customer = customers.get(userId);

  // Customers who have never written to us must not be contacted.
  if (!customer) return { allowed: false, rule: "no-prior-inbound" };

  // After STOP, nothing is sent until the customer sends START.
  if (customer.optedOut) return { allowed: false, rule: "opted-out" };

  // Free text is only allowed within 24 hours of the customer's last message.
  // Pre-approved templates are allowed outside that window.
  // The window is measured from the last message; it is closed at exactly 24 hours.
  if (type === "freeform" && now.getTime() - customer.lastInboundAt >= WINDOW_MS) {
    return { allowed: false, rule: "window-closed" };
  }

  return { allowed: true, rule: null };
}
