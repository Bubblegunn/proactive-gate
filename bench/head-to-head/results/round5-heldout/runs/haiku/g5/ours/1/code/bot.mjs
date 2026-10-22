// Decides whether one outgoing WhatsApp message may be sent through the
// WhatsApp Business Platform Cloud API. Pure function: no I/O, no history.
//
// Rules, checked in this order (first failure wins):
//   1. not_opted_in                 the patient has not agreed to WhatsApp messages
//   2. unsupported_message_type     type is neither "text" nor "template"
//   3. text only (free-form):
//      a. no_inbound_message        the patient never wrote to us, so no service window
//      b. invalid_inbound_timestamp the webhook timestamp is not a Unix time in seconds
//      c. inbound_timestamp_in_future the webhook timestamp is later than our clock
//      d. customer_service_window_closed more than 24 hours since the patient's last message
// Template messages are allowed for any opted-in patient, inside or outside the window.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const contact = message?.contact ?? {};

  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (message.type === "template") {
    return { allowed: true, reason: null };
  }

  if (message.type !== "text") {
    return deny("unsupported_message_type");
  }

  const last = contact.lastInboundTimestamp;
  if (last === null || last === undefined) {
    return deny("no_inbound_message");
  }

  // Meta sends the webhook `timestamp` as a string of Unix seconds (not milliseconds).
  if (typeof last !== "string" || !/^\d+$/.test(last)) {
    return deny("invalid_inbound_timestamp");
  }

  const lastMs = Number(last) * 1000;
  if (!Number.isSafeInteger(lastMs)) {
    return deny("invalid_inbound_timestamp");
  }

  const elapsedMs = now.getTime() - lastMs;
  if (elapsedMs < 0) {
    return deny("inbound_timestamp_in_future");
  }

  if (elapsedMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}
