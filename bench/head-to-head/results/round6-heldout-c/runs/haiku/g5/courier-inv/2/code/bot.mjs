// Follow-up gate for the customer-support assistant (WhatsApp Business and SMS).
// State is kept in process memory only: a restart forgets every opt-out.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Standard SMS/WhatsApp keywords. A message counts only when the whole body is one keyword.
const OPT_OUT_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const OPT_IN_WORDS = new Set(["START", "YES", "UNSTOP"]);

const users = new Map(); // userId -> { optedOut, lastInboundMs, optChangedMs }

// "  Stop! ", "s.t.o.p", "OPT-OUT" -> "STOP", "STOP", "OPTOUT". Non-letters are dropped, so
// "stop texting me" or "I can't stop by" never match.
function keyword(text) {
  return String(text).normalize("NFKC").replace(/[^\p{L}]/gu, "").toUpperCase();
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function onInbound(userId, text, at) {
  if (!validDate(at)) throw new TypeError("at must be a valid Date");
  const ms = at.getTime();

  let s = users.get(userId);
  if (!s) {
    s = { optedOut: false, lastInboundMs: null, optChangedMs: null };
    users.set(userId, s);
  }

  // Opt-out/opt-in is applied only if it is not older than the latest change we already hold.
  const word = keyword(text);
  const isOptOut = OPT_OUT_WORDS.has(word);
  const isOptIn = OPT_IN_WORDS.has(word);
  if ((isOptOut || isOptIn) && (s.optChangedMs === null || ms >= s.optChangedMs)) {
    s.optedOut = isOptOut;
    s.optChangedMs = ms;
  }

  if (s.lastInboundMs === null || ms > s.lastInboundMs) s.lastInboundMs = ms;
}

export function check(userId, type, now) {
  if (!validDate(now)) throw new TypeError("now must be a valid Date");
  if (type !== "freeform" && type !== "template") return { allowed: false, rule: "invalid_type" };

  const s = users.get(userId);
  if (s?.optedOut) return { allowed: false, rule: "opted_out" };

  // The assistant only follows up after a conversation, so a customer who never wrote is never messaged.
  if (!s || s.lastInboundMs === null) return { allowed: false, rule: "no_prior_inbound" };

  // Approved templates may be sent any time. Freeform text needs the 24-hour customer service window.
  if (type === "template") return { allowed: true, rule: null };

  const elapsed = now.getTime() - s.lastInboundMs;
  if (elapsed >= 0 && elapsed < WINDOW_MS) return { allowed: true, rule: null };
  return { allowed: false, rule: "outside_24h_window" };
}
