// WhatsApp Cloud API send gate. Decides per message, using only data the
// webhook handler already has, whether the assistant may send it now.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const deny = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

// Meta delivers the webhook `timestamp` as a string of Unix epoch seconds.
function parseInboundMs(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const ms = Number(raw) * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!message || typeof message !== 'object') return deny('invalid_message');

  const { type, contact } = message;

  // Opt-in is required for every business-initiated message, text or template.
  if (contact?.optedIn !== true) return deny('not_opted_in');

  // Pre-approved templates may be sent outside the 24-hour service window.
  if (type === 'template') return allow();

  if (type !== 'text') return deny('unsupported_message_type');

  // Free-form text is only allowed inside the 24-hour customer service window,
  // which opens with the patient's most recent inbound message.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) return deny('no_inbound_message');

  const inboundMs = parseInboundMs(raw);
  if (inboundMs === null) return deny('invalid_inbound_timestamp');

  if (now.getTime() - inboundMs >= SERVICE_WINDOW_MS) {
    return deny('service_window_closed');
  }
  return allow();
}
