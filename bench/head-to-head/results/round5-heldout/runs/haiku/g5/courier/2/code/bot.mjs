// Decides whether the assistant may send one WhatsApp message through the
// Cloud API. Pure function: no I/O, no stored history.
//
// Rules, checked in this order:
// 1. not_opted_in: the patient has not agreed to receive WhatsApp messages.
//    Applies to every message type.
// 2. Template messages (pre-approved Meta templates) may be sent at any time
//    after opt-in, including outside the 24-hour customer service window.
// 3. Free-form text may only be sent inside the customer service window.
//    The window opens when the patient's last inbound message arrives and
//    closes 24 hours later. A patient who never wrote to us has no window.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta sends webhook `timestamp` as a Unix time in whole seconds, as a string.
const UNIX_SECONDS = /^\d+$/;

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}

export function decideWhatsApp(message, now) {
  const { type, contact } = message ?? {};

  if (contact?.optedIn !== true) {
    return deny('not_opted_in');
  }

  if (type === 'template') {
    return allow();
  }

  if (type !== 'text') {
    return deny('unsupported_message_type');
  }

  const last = contact.lastInboundTimestamp;

  if (last === null || last === undefined) {
    return deny('customer_service_window_closed');
  }

  if (typeof last !== 'string' || !UNIX_SECONDS.test(last)) {
    return deny('invalid_inbound_timestamp');
  }

  const windowOpenedAt = Number(last) * 1000;
  const elapsed = now.getTime() - windowOpenedAt;

  // `!(x >= 0)` also catches NaN, e.g. from an invalid `now`.
  if (!(elapsed >= 0)) {
    return deny('invalid_inbound_timestamp');
  }

  if (elapsed >= WINDOW_MS) {
    return deny('customer_service_window_closed');
  }

  return allow();
}
