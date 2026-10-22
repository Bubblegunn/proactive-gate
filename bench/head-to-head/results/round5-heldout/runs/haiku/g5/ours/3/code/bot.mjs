// Decides whether one outbound WhatsApp message may be sent through the
// WhatsApp Business Platform Cloud API. Pure function: no I/O, no stored state.
//
// Rules, checked in this order (first failing rule wins):
//   1. Message shape is valid                 -> invalid_message / unsupported_message_type
//   2. Patient opted in to WhatsApp messages  -> not_opted_in
//   3. Template messages                      -> allowed (pre-approved, may start a conversation)
//   4. Free-form text needs an open 24-hour customer service window:
//        a. patient has written to us at least once -> no_inbound_message
//        b. the webhook timestamp is usable         -> invalid_inbound_timestamp
//        c. less than 24 hours since that message   -> customer_service_window_closed
//
// Meta webhook `timestamp` is Unix time in SECONDS, delivered as a decimal string
// (e.g. "1767272400"). It must be multiplied by 1000 before it is used as a Date.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta's clock and ours can differ slightly. An inbound timestamp up to this
// far ahead of our clock is accepted and treated as "just now".
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

// Returns the inbound time in epoch milliseconds, or null if the value is not a
// usable Meta timestamp string.
function parseInboundMs(value, nowMs) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const ms = Number(value) * 1000;
  if (!Number.isSafeInteger(ms)) return null;
  if (ms - nowMs > CLOCK_SKEW_TOLERANCE_MS) return null;
  return ms;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("decideWhatsApp: `now` must be a valid Date");
  }

  if (
    message === null ||
    typeof message !== "object" ||
    message.contact === null ||
    typeof message.contact !== "object"
  ) {
    return deny("invalid_message");
  }

  if (message.type !== "text" && message.type !== "template") {
    return deny("unsupported_message_type");
  }

  if (message.contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (message.type === "template") {
    return allow();
  }

  const last = message.contact.lastInboundTimestamp;
  if (last === null || last === undefined) {
    return deny("no_inbound_message");
  }

  const nowMs = now.getTime();
  const inboundMs = parseInboundMs(last, nowMs);
  if (inboundMs === null) {
    return deny("invalid_inbound_timestamp");
  }

  const elapsedMs = nowMs - inboundMs;
  if (elapsedMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return allow();
}
