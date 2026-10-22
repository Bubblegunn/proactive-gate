// WhatsApp Cloud API send gate. Decides, per message and before any API call,
// whether the send may go out. Pure function: no I/O, no stored history.

// Meta's customer service window: 24 hours from the customer's last inbound message.
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta's webhook `timestamp` is Unix time in whole seconds, sent as a string.
// A value further ahead of our clock than this is not a plausible Meta timestamp
// (for example a milliseconds value read as seconds).
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const blocked = (reason) => ({ allowed: false, reason });
const allowed = () => ({ allowed: true, reason: null });

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const { type, contact } = message;

  // Opt-in applies to every business-initiated message, template or free-form.
  if (contact?.optedIn !== true) {
    return blocked('not_opted_in');
  }

  // Template messages are pre-approved by Meta and may be sent at any time to an opted-in contact.
  if (type === 'template') {
    return allowed();
  }

  // Free-form messages are only allowed inside the customer service window.
  if (type !== 'text') {
    return blocked('unsupported_message_type');
  }

  const last = contact.lastInboundTimestamp;
  if (last === null || last === undefined) {
    return blocked('no_inbound_message');
  }
  if (typeof last !== 'string' || !/^\d+$/.test(last)) {
    return blocked('invalid_inbound_timestamp');
  }

  const lastInboundMs = Number(last) * 1000;
  if (lastInboundMs > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return blocked('invalid_inbound_timestamp');
  }

  const elapsedMs = now.getTime() - lastInboundMs;
  if (elapsedMs >= CUSTOMER_SERVICE_WINDOW_MS) {
    return blocked('customer_window_closed');
  }

  return allowed();
}
