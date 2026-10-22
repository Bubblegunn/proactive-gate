// Follow-up gate for the WhatsApp Business / SMS support assistant.
// Decides whether the assistant may send an unprompted follow-up to a customer.
// State is in memory only; a process restart clears it.

const WINDOW_MS = 24 * 60 * 60 * 1000; // WhatsApp customer-service window

// Opt-out and opt-in keywords, as used by text-message programs (CTIA list).
// Only the whole message counts, so "please don't stop" is normal conversation.
const STOP_WORDS = new Set(["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP"]);

const states = new Map();

function block(rule) {
  return { allowed: false, rule };
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

// Reduce a message to its bare keyword: NFKC, drop invisible characters,
// strip leading/trailing punctuation, spaces and emoji, collapse inner spaces, uppercase.
function normalize(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function stateFor(userId) {
  let s = states.get(userId);
  if (!s) {
    s = { lastInboundAt: null, optEvent: null };
    states.set(userId, s);
  }
  return s;
}

export function onInbound(userId, text, at) {
  if (!isValidDate(at)) throw new TypeError("onInbound: at must be a valid Date");

  const s = stateFor(userId);
  if (!s.lastInboundAt || at > s.lastInboundAt) s.lastInboundAt = at;

  const word = normalize(text);
  let kind = null;
  if (STOP_WORDS.has(word)) kind = "stop";
  else if (START_WORDS.has(word)) kind = "start";

  // The latest opt-out or opt-in wins, even if messages arrive out of order.
  if (kind && (!s.optEvent || at >= s.optEvent.at)) {
    s.optEvent = { kind, at };
  }
}

export function check(userId, type, now) {
  if (type !== "freeform" && type !== "template") return block("unknown-type");
  if (!isValidDate(now)) return block("invalid-now");

  const s = states.get(userId);
  if (!s || !s.lastInboundAt) return block("no-prior-inbound");
  if (s.optEvent?.kind === "stop") return block("opted-out");
  // Free text only inside the 24h window after the customer's last message.
  // Pre-approved templates may be sent outside it.
  if (type === "freeform" && now - s.lastInboundAt >= WINDOW_MS) {
    return block("freeform-window-closed");
  }

  return { allowed: true, rule: null };
}
