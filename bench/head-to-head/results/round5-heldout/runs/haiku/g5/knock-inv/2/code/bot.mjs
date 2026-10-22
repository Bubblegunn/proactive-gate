// Decides whether one outbound WhatsApp message may be sent through the
// WhatsApp Business Platform Cloud API. Pure function: no I/O, no stored state.
//
// Rules, checked in this order:
//   1. The patient must have opted in to WhatsApp messages from us (all types).
//   2. A "template" message (pre-approved Meta template) may be sent at any time
//      once the patient has opted in.
//   3. A "text" (free-form) message is allowed only inside the customer service
//      window: 24 hours after the patient's last inbound message.
//
// lastInboundTimestamp is the `timestamp` field of the webhook message, exactly
// as Meta delivers it: a string holding a Unix time in whole seconds (10 digits
// today), not milliseconds.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const META_UNIX_SECONDS = /^\d{10}$/;

function deny(reason) {
  return { allowed: false, reason };
}

function allow() {
  return { allowed: true, reason: null };
}

// Returns the message time in epoch milliseconds, or null if the value is not a
// Meta webhook timestamp.
function parseMetaTimestamp(value) {
  if (typeof value !== "string" || !META_UNIX_SECONDS.test(value)) {
    return null;
  }
  return Number(value) * 1000;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const contact = message?.contact;
  if (contact?.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (message.type === "template") {
    return allow();
  }

  if (message.type !== "text") {
    return deny("unsupported_message_type");
  }

  if (contact.lastInboundTimestamp === null || contact.lastInboundTimestamp === undefined) {
    return deny("no_customer_service_window");
  }

  const lastInboundMs = parseMetaTimestamp(contact.lastInboundTimestamp);
  if (lastInboundMs === null) {
    return deny("invalid_inbound_timestamp");
  }

  const elapsedMs = now.getTime() - lastInboundMs;
  // A message timestamp after our server clock means the clocks disagree.
  // We cannot prove the window is open, so we refuse.
  if (elapsedMs < 0) {
    return deny("invalid_inbound_timestamp");
  }

  // The window closes exactly 24 hours after the inbound message.
  if (elapsedMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return allow();
}
