// Follow-up gate for the customer-support assistant (WhatsApp Business + SMS).
// Decides whether the assistant may send a follow-up to a customer.
// State is kept in memory only and is lost on restart.

const DAY_MS = 24 * 60 * 60 * 1000;

// Opt-out keywords (carrier / CTIA list). Only a whole message counts.
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
// Opt-in keywords that lift an opt-out.
const START_WORDS = new Set(["START", "UNSTOP"]);

// userId -> { lastInboundAt, statusAt, optedOut }   (times in epoch ms)
const users = new Map();

// Returns "stop", "start", or null. Ignores case, spaces, punctuation and
// zero-width characters, and folds full-width letters, so "  Stop!! " and
// "ＳＴＯＰ" both match. A keyword inside a longer sentence does not match.
function keywordOf(text) {
  if (typeof text !== "string") return null;
  const letters = text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  if (STOP_WORDS.has(letters)) return "stop";
  if (START_WORDS.has(letters)) return "start";
  return null;
}

function block(rule) {
  return { allowed: false, rule };
}

export function onInbound(userId, text, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError("onInbound: at must be a valid Date");
  }
  const t = at.getTime();
  const rec = users.get(userId) ?? { lastInboundAt: t, statusAt: null, optedOut: false };

  if (t > rec.lastInboundAt) rec.lastInboundAt = t;

  const kw = keywordOf(text);
  // Apply an opt-in/opt-out only if it is not older than the last one applied,
  // so late-arriving messages cannot undo a newer STOP.
  if (kw && (rec.statusAt === null || t >= rec.statusAt)) {
    rec.statusAt = t;
    rec.optedOut = kw === "stop";
  }

  users.set(userId, rec);
}

export function check(userId, type, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("check: now must be a valid Date");
  }
  if (type !== "freeform" && type !== "template") {
    return block("unknown-message-type");
  }

  // Never-contacted customers: the assistant may only follow up on a conversation they started.
  const rec = users.get(userId);
  if (!rec) return block("no-prior-contact");

  // Honor STOP until the customer sends START or UNSTOP. Applies to all message types.
  if (rec.optedOut) return block("opted-out");

  // Free text is allowed only inside the 24-hour customer-service window that
  // opens with the customer's last inbound message. Templates are exempt.
  if (type === "freeform" && now.getTime() - rec.lastInboundAt >= DAY_MS) {
    return block("freeform-window-closed");
  }

  return { allowed: true, rule: null };
}
