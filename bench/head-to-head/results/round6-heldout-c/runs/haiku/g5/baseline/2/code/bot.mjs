// In-memory gate for the assistant's own follow-up messages.
// Rules are checked in order; the first rule that blocks is reported.
//
// Rules:
//   opted_out               customer sent an opt-out keyword and has not sent a start keyword since
//   no_open_service_window  freeform text only while the customer's last message is < 24 h old
//   unknown_type            type is neither "freeform" nor "template"
// Templates are not limited by the window, only by opt-out.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Standard US carrier opt-out / opt-in keywords (CTIA messaging principles).
const OPT_OUT_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const OPT_IN_WORDS = new Set(["start", "unstop"]);

const TYPES = new Set(["freeform", "template"]);

// userId -> { lastInboundMs: number | null, optedOut: boolean }
const customers = new Map();

// Reduces a message to the bare word it may contain, so that "  STOP!! " and "Stop."
// match but "stop by the store" does not. Strips zero-width characters, collapses
// whitespace (including NBSP), and drops leading/trailing punctuation and emoji.
function keyword(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toLowerCase();
}

export function onInbound(userId, text, at) {
  const customer = customers.get(userId) ?? { lastInboundMs: null, optedOut: false };

  const word = keyword(text);
  if (OPT_OUT_WORDS.has(word)) {
    customer.optedOut = true;
  } else if (OPT_IN_WORDS.has(word)) {
    customer.optedOut = false;
  }

  // An invalid timestamp is ignored rather than stored, so it cannot poison later comparisons.
  // The window then stays closed, which is the fail-closed direction.
  const ms = at.getTime();
  if (Number.isFinite(ms) && (customer.lastInboundMs === null || ms > customer.lastInboundMs)) {
    customer.lastInboundMs = ms;
  }

  customers.set(userId, customer);
}

export function check(userId, type, now) {
  if (!TYPES.has(type)) {
    return { allowed: false, rule: "unknown_type" };
  }

  const customer = customers.get(userId);

  if (customer?.optedOut) {
    return { allowed: false, rule: "opted_out" };
  }

  if (type === "template") {
    return { allowed: true, rule: null };
  }

  // Freeform: only inside the 24 h window opened by the customer's last message.
  // A customer who has never written to us has no window, so freeform is blocked.
  const lastMs = customer?.lastInboundMs ?? null;
  const windowOpen = lastMs !== null && now.getTime() - lastMs < WINDOW_MS;
  if (!windowOpen) {
    return { allowed: false, rule: "no_open_service_window" };
  }

  return { allowed: true, rule: null };
}
