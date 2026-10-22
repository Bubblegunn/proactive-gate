// Follow-up gate for the WhatsApp / SMS support assistant.
// State is in memory only: a restart forgets every user.

const WINDOW_MS = 24 * 60 * 60 * 1000; // WhatsApp customer service window

// Carrier-style keywords, matched as the whole message.
const STOP_WORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE",
  "OPT OUT", "OPT-OUT", "OPTOUT",
]);
const START_WORDS = new Set(["START", "UNSTOP"]);

// userId -> { lastInboundAt: number | null, lastOptEvent: { kind, at } | null }
const users = new Map();

function keywordOf(text) {
  const cleaned = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "") // zero-width and other invisible characters
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "") // outer punctuation, symbols, spaces
    .toUpperCase();
  if (STOP_WORDS.has(cleaned)) return "stop";
  if (START_WORDS.has(cleaned)) return "start";
  return null;
}

function recordFor(userId) {
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  let user = users.get(userId);
  if (!user) {
    user = { lastInboundAt: null, lastOptEvent: null };
    users.set(userId, user);
  }
  return user;
}

export function onInbound(userId, text, at) {
  const user = recordFor(userId);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError("at must be a valid Date");
  }
  const t = at.getTime();
  user.lastInboundAt = user.lastInboundAt === null ? t : Math.max(user.lastInboundAt, t);

  // Media messages arrive without a body; they still count as contact.
  const kind = keywordOf(typeof text === "string" ? text : "");
  if (kind) {
    const prev = user.lastOptEvent;
    // The latest opt event wins; on a tie, STOP wins.
    if (!prev || t > prev.at || (t === prev.at && kind === "stop")) {
      user.lastOptEvent = { kind, at: t };
    }
  }
}

function allow() {
  return { allowed: true, rule: null };
}

function block(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  if (typeof userId !== "string" || userId === "") return block("invalid-user");
  if (type !== "freeform" && type !== "template") return block("invalid-type");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid-time");

  const user = users.get(userId);
  if (user?.lastOptEvent?.kind === "stop") return block("opted-out");

  const last = user?.lastInboundAt ?? null;
  if (type === "freeform") {
    // Free text only inside 24 h of the customer's last message.
    if (last === null) return block("outside-24h-window");
    const age = now.getTime() - last;
    if (age < 0 || age >= WINDOW_MS) return block("outside-24h-window");
    return allow();
  }

  // Templates need some sign that the customer wrote to us first.
  if (last === null) return block("no-customer-contact");
  return allow();
}
