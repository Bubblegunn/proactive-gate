// Decides, before any WhatsApp Cloud API call, whether a message may be sent.
// Pure function: no I/O and no stored history. Each call uses only the
// message and the contact fields the webhook handler already has.
//
// Rules (WhatsApp Business Platform):
// 1. The patient must have opted in before the business messages them at all.
// 2. Template messages (pre-approved by Meta) may be sent to an opted-in
//    contact at any time, with or without an open service window.
// 3. Free-form text may only be sent inside the 24-hour customer service
//    window, which opens when the patient messages us and closes 24 hours later.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta's webhook `timestamp` is Unix time in whole seconds, as a string.
// A small allowance covers clock drift between Meta's servers and ours.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const ALLOW = Object.freeze({ allowed: true, reason: null });

function deny(reason) {
  return { allowed: false, reason };
}

// Returns the inbound time in ms, null if the patient never wrote to us,
// or undefined if the value is present but cannot be trusted.
function parseLastInbound(raw, now) {
  if (raw === null) return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;

  // Seconds, not milliseconds. A millisecond value would land far in the
  // future and wrongly keep the window open, so the skew check rejects it.
  const ms = Number(raw) * 1000;
  if (!Number.isSafeInteger(ms)) return undefined;
  if (ms > now.getTime() + MAX_CLOCK_SKEW_MS) return undefined;
  return ms;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("decideWhatsApp: now must be a valid Date");
  }

  const type = message?.type;
  if (type !== "text" && type !== "template") {
    return deny("unsupported_message_type");
  }

  const contact = message.contact;
  if (contact === null || typeof contact !== "object") {
    return deny("missing_contact");
  }

  // Strict check: only an explicit true counts as consent.
  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (type === "template") {
    return ALLOW;
  }

  const inbound = parseLastInbound(contact.lastInboundTimestamp, now);
  if (inbound === undefined) {
    return deny("invalid_inbound_timestamp");
  }
  if (inbound === null) {
    return deny("outside_customer_service_window");
  }
  if (now.getTime() - inbound >= WINDOW_MS) {
    return deny("outside_customer_service_window");
  }
  return ALLOW;
}
