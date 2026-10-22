// Decides whether the assistant may send one WhatsApp message to a patient,
// before the Cloud API call is made. Pure function: no I/O, no stored state.
//
// Rules (checked in this order, first failure wins):
//   1. The patient must have opted in to WhatsApp messages from us.
//   2. The message must be a "text" (free-form) or "template" (pre-approved) message.
//   3. A free-form text is allowed only inside the 24-hour customer service
//      window, which opens when the patient last wrote to us and closes 24 h later.
//      Templates are not bound to that window.
//
// Meta's webhook `timestamp` is Unix time in whole seconds, sent as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;

function deny(reason) {
  return { allowed: false, reason };
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny("invalid_now");
  }

  const contact = message?.contact;

  if (contact?.optedIn !== true) {
    return deny("contact_not_opted_in");
  }

  if (message.type === "template") {
    return { allowed: true, reason: null };
  }

  if (message.type !== "text") {
    return deny("unsupported_message_type");
  }

  const raw = contact.lastInboundTimestamp;

  if (raw === null || raw === undefined) {
    return deny("no_customer_service_window");
  }

  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return deny("invalid_inbound_timestamp");
  }

  const inboundMs = Number(raw) * 1000;
  const elapsedMs = now.getTime() - inboundMs;

  if (elapsedMs < 0) {
    return deny("inbound_timestamp_in_future");
  }

  if (elapsedMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return { allowed: true, reason: null };
}
