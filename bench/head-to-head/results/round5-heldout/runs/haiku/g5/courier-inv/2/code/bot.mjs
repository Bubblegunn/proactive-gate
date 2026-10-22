// Decides whether one outbound WhatsApp message may be sent through the
// WhatsApp Business Platform (Cloud API). Pure function: no I/O, no storage.
//
// Rules, checked in this order:
//   1. The patient must have opted in to WhatsApp messages from us.
//   2. The message type must be "text" (free-form) or "template" (pre-approved).
//   3. Free-form text needs an open customer service window: the patient must
//      have sent us a message less than 24 hours ago.
//      Templates skip this rule.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta sends webhook `timestamp` as Unix time in seconds, as a string.
// Allow a few minutes of clock skew between Meta and our server; anything
// further ahead is treated as malformed (for example, milliseconds).
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function decideWhatsApp(message, now) {
  const { type, contact } = message;

  if (contact?.optedIn !== true) {
    return { allowed: false, reason: "not_opted_in" };
  }

  if (type === "template") {
    return { allowed: true, reason: null };
  }

  if (type !== "text") {
    return { allowed: false, reason: "unknown_message_type" };
  }

  const last = contact.lastInboundTimestamp;

  // Never written to us: no window has ever opened.
  if (last === null || last === undefined) {
    return { allowed: false, reason: "outside_service_window" };
  }

  if (typeof last !== "string" || !/^\d+$/.test(last)) {
    return { allowed: false, reason: "invalid_inbound_timestamp" };
  }

  const inboundMs = Number(last) * 1000;
  const nowMs = now.getTime();

  if (!Number.isFinite(inboundMs) || inboundMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return { allowed: false, reason: "invalid_inbound_timestamp" };
  }

  // Strictly less than 24 hours: the window is closed at exactly 24 hours.
  if (nowMs - inboundMs < WINDOW_MS) {
    return { allowed: true, reason: null };
  }

  return { allowed: false, reason: "outside_service_window" };
}
