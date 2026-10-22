// Decides whether the assistant may send one WhatsApp message through the
// WhatsApp Business Platform (Cloud API). Pure function: no I/O, no state.
//
// Rules, checked in this order:
// 1. Unknown message type            -> deny "unknown_message_type"
// 2. Patient has not opted in        -> deny "not_opted_in"
// 3. Template message                -> allow (pre-approved templates may be
//                                       sent at any time to an opted-in contact)
// 4. Free-form text needs an open customer service window: the window opens
//    when the patient writes to us and stays open for 24 hours after that
//    message.
//    - Patient never wrote to us     -> deny "outside_customer_service_window"
//    - Malformed webhook timestamp   -> deny "invalid_last_inbound_timestamp"
//    - Window elapsed (>= 24 h)      -> deny "outside_customer_service_window"
//    - Otherwise                     -> allow

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Tolerated lead of the webhook timestamp over our clock. Larger leads mean
// the timestamp is not a valid past event (for example a unit mix-up).
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const allow = () => ({ allowed: true, reason: null });
const deny = (reason) => ({ allowed: false, reason });

// Meta sends `timestamp` as a string of Unix time in whole seconds, e.g.
// "1767272400". Returns epoch milliseconds, or null if the value is not a
// usable seconds timestamp.
function parseInboundTimestamp(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const ms = Number(value) * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const type = message?.type;
  const contact = message?.contact;

  if (type !== "text" && type !== "template") {
    return deny("unknown_message_type");
  }

  if (contact?.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (type === "template") {
    return allow();
  }

  const last = contact.lastInboundTimestamp ?? null;
  if (last === null) {
    return deny("outside_customer_service_window");
  }

  const lastMs = parseInboundTimestamp(last);
  if (lastMs === null) {
    return deny("invalid_last_inbound_timestamp");
  }

  const elapsedMs = now.getTime() - lastMs;
  if (elapsedMs < -MAX_CLOCK_SKEW_MS) {
    return deny("invalid_last_inbound_timestamp");
  }
  if (elapsedMs >= WINDOW_MS) {
    return deny("outside_customer_service_window");
  }

  return allow();
}
