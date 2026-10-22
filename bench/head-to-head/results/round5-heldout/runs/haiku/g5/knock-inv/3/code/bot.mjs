// WhatsApp Cloud API send gate.
//
// Decides, before any API call, whether a message may be sent to a patient.
// Pure function: no I/O, no stored history.
//
// Rules (checked in this order, first failure wins):
//   1. message.type must be "text" or "template".
//   2. `now` must be a valid Date.
//   3. The patient must have opted in to WhatsApp messages from us.
//   4. Template messages (pre-approved Meta templates) may be sent to an
//      opted-in patient at any time, with or without a prior inbound message.
//   5. Free-form text messages need a customer service window: the patient
//      must have written to us less than 24 hours ago.
//
// Meta's `timestamp` on inbound webhook messages is a Unix time in seconds,
// delivered as a string (e.g. "1767272400"). It must be converted to
// milliseconds before it is used as a Date value.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta timestamps come from Meta's clock. Allow a small skew before treating
// an inbound timestamp as impossible (in the future).
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseInboundMs(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds * 1000;
}

/**
 * @param {{ type: "text" | "template", contact: { optedIn: boolean, lastInboundTimestamp: string | null } }} message
 * @param {Date} now server clock
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function decideWhatsApp(message, now) {
  const deny = (reason) => ({ allowed: false, reason });
  const allow = () => ({ allowed: true, reason: null });

  const type = message?.type;
  if (type !== "text" && type !== "template") {
    return deny("invalid_message_type");
  }

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) {
    return deny("invalid_clock");
  }

  const contact = message.contact ?? {};
  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (type === "template") {
    return allow();
  }

  // Free-form text: requires an open customer service window.
  const raw = contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) {
    return deny("no_inbound_message");
  }

  const inboundMs = parseInboundMs(raw);
  if (inboundMs === null || inboundMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return deny("invalid_inbound_timestamp");
  }

  const elapsedMs = Math.max(0, nowMs - inboundMs);
  if (elapsedMs >= WINDOW_MS) {
    return deny("service_window_closed");
  }

  return allow();
}
