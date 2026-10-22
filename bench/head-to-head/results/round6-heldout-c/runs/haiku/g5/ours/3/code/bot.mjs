// Follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
// State lives in memory only. Nothing is sent from this module.
//
// Rules, in the order check() applies them:
//   1. invalid-input            bad userId, type or now -> blocked (fail closed)
//   2. no-inbound-consent       customer never wrote to us -> blocked for every type
//   3. opted-out                customer sent a STOP keyword and has not sent START since -> blocked for every type
//   4. now-before-last-inbound  freeform only; clock is behind the last inbound message -> blocked
//   5. outside-24h-window       freeform only; more than 24 h since the customer's last inbound message -> blocked
//   Templates pass rules 1-3 without a session window, because the platform allows approved templates outside it.

const DAY_MS = 24 * 60 * 60 * 1000;

// Opt-out and opt-in keywords follow the US carrier convention (CTIA guidelines, Twilio defaults).
// Only a whole message counts, so "I can't stop thinking about my bill" is ordinary conversation.
const OPT_OUT_MESSAGES = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "STOP TEXTING ME",
  "STOP MESSAGING ME",
  "UNSUBSCRIBE ME",
  "DO NOT TEXT ME",
  "DONT TEXT ME",
]);
const OPT_IN_MESSAGES = new Set(["START", "YES", "UNSTOP"]);

// Reduces a raw message to upper-case words separated by single spaces, so that
// "  Stop!! ", "STOP.", "🛑 stop", "ｓｔｏｐ" and "stop​" all become "STOP".
function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "") // zero-width characters from phone keyboards
    .replace(/['’]/g, "") // "don't" -> "dont"
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function classify(text) {
  const message = normalize(text);
  if (OPT_OUT_MESSAGES.has(message)) return "opt-out";
  if (OPT_IN_MESSAGES.has(message)) return "opt-in";
  return null;
}

// userId -> { lastInboundMs, optedOut, stateMs }
// stateMs is the time of the keyword message that set optedOut, so an opt-out or
// opt-in that arrives late (out of order) cannot overwrite a newer one.
const customers = new Map();

function toMs(date, name) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return date.getTime();
}

function block(rule) {
  return { allowed: false, rule };
}

export function onInbound(userId, text, at) {
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  if (text !== null && text !== undefined && typeof text !== "string") {
    throw new TypeError("text must be a string, null or undefined");
  }
  const atMs = toMs(at, "at");

  const customer = customers.get(userId) ?? { lastInboundMs: atMs, optedOut: false, stateMs: null };
  customer.lastInboundMs = Math.max(customer.lastInboundMs, atMs);

  const keyword = classify(text);
  if (keyword && (customer.stateMs === null || atMs >= customer.stateMs)) {
    customer.optedOut = keyword === "opt-out";
    customer.stateMs = atMs;
  }

  customers.set(userId, customer);
}

export function check(userId, type, now) {
  if (
    typeof userId !== "string" ||
    userId === "" ||
    (type !== "freeform" && type !== "template") ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    return block("invalid-input");
  }

  const customer = customers.get(userId);
  if (!customer) return block("no-inbound-consent");
  if (customer.optedOut) return block("opted-out");
  if (type === "template") return { allowed: true, rule: null };

  const ageMs = now.getTime() - customer.lastInboundMs;
  if (ageMs < 0) return block("now-before-last-inbound");
  if (ageMs >= DAY_MS) return block("outside-24h-window");
  return { allowed: true, rule: null };
}
