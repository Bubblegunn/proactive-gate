// WhatsApp Cloud API send gate. Decides, before any API call, whether a
// message may be sent to a patient. Pure function: no I/O, no stored state.
//
// Rules (WhatsApp Business Platform policy):
// 1. The patient must have opted in to WhatsApp messages from us.
// 2. A template message may be sent to an opted-in patient at any time.
// 3. A free-form (text) message may only be sent inside the customer service
//    window: less than 24 hours after the patient's last inbound message.
//
// Webhook timestamps are Unix time in SECONDS, delivered as a string.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideWhatsApp(message, now) {
  if (message.type !== 'text' && message.type !== 'template') {
    return reject('unknown_message_type');
  }

  // Anything other than a literal true counts as no opt-in.
  if (message.contact.optedIn !== true) {
    return reject('not_opted_in');
  }

  if (message.type === 'template') {
    return { allowed: true, reason: null };
  }

  const last = message.contact.lastInboundTimestamp;
  if (last === null || last === undefined) {
    // The patient has never written to us, so no window is open.
    return reject('outside_service_window');
  }

  const raw = String(last);
  if (!/^\d+$/.test(raw)) {
    return reject('invalid_inbound_timestamp');
  }

  const inboundMs = Number(raw) * 1000;
  const elapsedMs = now.getTime() - inboundMs;

  // NaN from a bad clock also falls through here and is rejected.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return reject('invalid_inbound_timestamp');
  }

  if (elapsedMs >= SERVICE_WINDOW_MS) {
    return reject('outside_service_window');
  }

  return { allowed: true, reason: null };
}

function reject(reason) {
  return { allowed: false, reason };
}
