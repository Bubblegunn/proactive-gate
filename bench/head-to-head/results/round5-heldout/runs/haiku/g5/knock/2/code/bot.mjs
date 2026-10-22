// Decides, before any Cloud API call, whether a WhatsApp message may be sent.
//
// Rules (WhatsApp Business Platform policy):
// 1. The patient must have opted in to WhatsApp messages from us. This applies
//    to every message type, template or free-form.
// 2. A template message may be sent at any time once the opt-in exists.
// 3. A free-form (text) message may only be sent inside the 24-hour customer
//    service window, which opens when the patient last wrote to us and closes
//    24 hours later. Outside the window, only templates are allowed.
//
// Webhook timestamps are Unix epoch seconds delivered as a decimal string
// (e.g. "1767272400" = 2026-01-01T13:00:00Z), so they are multiplied by 1000
// before they become a Date.

const WINDOW_MS = 24 * 60 * 60 * 1000;

function deny(reason) {
  return { allowed: false, reason };
}

function allow() {
  return { allowed: true, reason: null };
}

// Returns the inbound time as a Date, or null if the value is not a valid
// epoch-seconds string. Callers handle null (no message / invalid) themselves.
function parseInboundTimestamp(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const { type, contact } = message;

  if (type !== 'text' && type !== 'template') {
    return deny('unknown_message_type');
  }

  if (contact?.optedIn !== true) {
    return deny('not_opted_in');
  }

  if (type === 'template') {
    return allow();
  }

  // Free-form text: needs an open customer service window.
  if (contact.lastInboundTimestamp == null) {
    return deny('no_customer_message');
  }

  const lastInbound = parseInboundTimestamp(contact.lastInboundTimestamp);
  if (lastInbound === null) {
    return deny('invalid_last_inbound_timestamp');
  }

  const elapsedMs = now.getTime() - lastInbound.getTime();

  // An inbound message cannot be newer than our clock. Treat it as bad data
  // rather than as an open window.
  if (elapsedMs < 0) {
    return deny('invalid_last_inbound_timestamp');
  }

  if (elapsedMs >= WINDOW_MS) {
    return deny('customer_service_window_closed');
  }

  return allow();
}
