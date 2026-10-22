// Decides whether one outgoing WhatsApp message may be sent through the
// WhatsApp Business Platform (Cloud API). Pure function: no I/O, no state.
//
// Rules, checked in order:
//   1. The clock and the message must be well formed.
//   2. The patient must have opted in. Applies to every message type.
//   3. A template message is business-initiated and may be sent at any time
//      once opted in. Only pre-approved templates may be used this way.
//   4. A free-form text message needs an open customer service window:
//      the patient must have written to us, and less than 24 hours may have
//      passed since that message.
//
// Meta delivers webhook `timestamp` as a Unix time in whole seconds, sent as a
// string (e.g. "1767272400"). It is converted to milliseconds before comparing
// with the Date from our clock.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny("invalid_clock");
  }

  const { type, contact } = message ?? {};
  if (type !== "text" && type !== "template") {
    return deny("invalid_message_type");
  }
  if (contact == null || typeof contact !== "object") {
    return deny("invalid_contact");
  }

  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (type === "template") {
    return allow();
  }

  const { lastInboundTimestamp } = contact;
  if (lastInboundTimestamp === null || lastInboundTimestamp === undefined) {
    return deny("no_customer_service_window");
  }

  const lastInboundMs = parseInboundTimestamp(lastInboundTimestamp);
  if (lastInboundMs === null) {
    return deny("invalid_inbound_timestamp");
  }

  const elapsedMs = now.getTime() - lastInboundMs;
  if (elapsedMs < 0) {
    return deny("inbound_timestamp_in_future");
  }
  if (elapsedMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return allow();
}

function parseInboundTimestamp(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  return seconds * 1000;
}

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}
