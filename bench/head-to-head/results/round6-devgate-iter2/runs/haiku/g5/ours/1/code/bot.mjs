// Decides whether the assistant may send one WhatsApp message to a patient.
//
// Rules (WhatsApp Business Platform / Cloud API):
// - Opt-in: the business may only message a user who opted in. Checked first, for every message type.
// - Templates: pre-approved templates may be sent at any time once opted in.
// - Free-form text: only inside the customer service window, which is 24 hours
//   from the user's most recent inbound message. Outside it, Meta rejects the send.
// - Webhook `timestamp` is a Unix time in whole seconds, sent as a string.
//   It is not in milliseconds, so it must be multiplied by 1000 before use.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideWhatsApp(message, now) {
  const block = (reason) => ({ allowed: false, reason });

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block('invalid_clock');
  }

  const contact = message?.contact;
  if (contact?.optedIn !== true) {
    return block('not_opted_in');
  }

  if (message.type === 'template') {
    return { allowed: true, reason: null };
  }

  if (message.type !== 'text') {
    return block('unknown_message_type');
  }

  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) {
    return block('no_inbound_message');
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return block('invalid_inbound_timestamp');
  }

  const lastInboundMs = Number(raw) * 1000;
  if (!Number.isSafeInteger(lastInboundMs)) {
    return block('invalid_inbound_timestamp');
  }

  const nowMs = now.getTime();
  if (lastInboundMs > nowMs) {
    return block('inbound_timestamp_in_future');
  }

  if (nowMs - lastInboundMs >= WINDOW_MS) {
    return block('service_window_closed');
  }

  return { allowed: true, reason: null };
}
