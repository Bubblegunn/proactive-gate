// Follow-up gate for WhatsApp Business and SMS. Decides whether the assistant
// may send a follow-up to a customer. Keeps all state in memory; nothing is sent here.
//
// Rules, checked in this order:
//   opted-out              the customer's latest opt-in/opt-out keyword is a stop keyword
//   no-prior-inbound       the customer has never written to us
//   freeform-window-closed freeform text, and more than 24h since the customer's last message
//
// Templates skip the 24-hour window check. WhatsApp allows approved templates outside it.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Carrier opt-out and opt-in keywords (CTIA), matched against the whole message only.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "yes", "unstop"]);

// Polite free-text stop requests. Anchored, so "stop by the store" is not a match.
const STOP_PHRASES = [
  /^(please )?(stop|quit) (texting|messaging|sending|contacting|bothering) me( please)?$/,
  /^(please )?(do not|don't|dont) (text|message|contact) me( anymore)?( please)?$/,
  /^(please )?(stop|unsubscribe|remove) me( please)?$/,
];

const states = new Map(); // userId -> { lastInboundMs, optEvent: { kind, atMs } | null }

function normalize(text) {
  return String(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, "") // zero-width characters
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ") // punctuation, emoji, symbols become spaces
    .trim()
    .replace(/\s+/g, " ");
}

// Returns "stop", "start", or null. A keyword counts only when it is the whole message.
function classify(text) {
  const words = normalize(text);
  if (words === "") return null;

  // Removing spaces and apostrophes lets "S.T.O.P" and "s t o p" match too.
  const compact = words.replace(/[\s']+/g, "");
  if (STOP_WORDS.has(compact)) return "stop";
  if (START_WORDS.has(compact)) return "start";

  if (STOP_PHRASES.some((re) => re.test(words))) return "stop";
  return null;
}

function validDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value.getTime();
}

export function onInbound(userId, text, at) {
  const atMs = validDate(at, "at");
  const state = states.get(userId) ?? { lastInboundMs: null, optEvent: null };

  state.lastInboundMs = state.lastInboundMs === null ? atMs : Math.max(state.lastInboundMs, atMs);

  // A late-arriving message does not overwrite a newer keyword.
  const kind = classify(text);
  if (kind !== null && (state.optEvent === null || atMs >= state.optEvent.atMs)) {
    state.optEvent = { kind, atMs };
  }

  states.set(userId, state);
}

export function check(userId, type, now) {
  if (type !== "freeform" && type !== "template") {
    throw new TypeError(`type must be "freeform" or "template", got ${String(type)}`);
  }
  const nowMs = validDate(now, "now");
  const state = states.get(userId);

  if (state?.optEvent?.kind === "stop") return { allowed: false, rule: "opted-out" };
  if (!state || state.lastInboundMs === null) return { allowed: false, rule: "no-prior-inbound" };

  if (type === "freeform") {
    const elapsed = nowMs - state.lastInboundMs;
    if (elapsed < 0 || elapsed >= WINDOW_MS) {
      return { allowed: false, rule: "freeform-window-closed" };
    }
  }

  return { allowed: true, rule: null };
}
