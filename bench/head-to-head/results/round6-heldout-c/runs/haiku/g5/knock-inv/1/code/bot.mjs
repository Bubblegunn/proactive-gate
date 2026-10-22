// Follow-up gate for the WhatsApp / SMS support assistant.
// In-memory only: state is lost on restart.
//
// Rules, checked in this order by check():
//   invalid_type          - type is not "freeform" or "template" (fail closed)
//   invalid_time          - now is not a valid Date (fail closed)
//   opted_out             - customer sent a STOP keyword and has not sent START since
//   no_prior_inbound      - customer has never written to us; no follow-up at all
//   freeform_window_closed - free text only within 24h of the customer's last message;
//                            after that only a pre-approved template may be sent

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Carrier / CTIA opt-out keywords. Matched against the whole message only,
// so ordinary sentences containing these words are not opt-outs.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

// Carrier / CTIA opt-in keywords.
const START_WORDS = new Set(['start', 'unstop']);

const states = new Map();

function stateFor(userId) {
  let s = states.get(userId);
  if (!s) {
    s = { lastInbound: null, optedOut: false };
    states.set(userId, s);
  }
  return s;
}

// Reduce a raw message to a comparable keyword:
// drop invisible format characters (zero-width spaces etc.), apply NFKC,
// lowercase, turn any run of non-letter/non-digit characters into one space,
// and trim. "  STOP!! " -> "stop", "Stop." -> "stop", "s​top" -> "stop".
function normalize(text) {
  return String(text)
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function onInbound(userId, text, at) {
  const s = stateFor(userId);
  const when = at instanceof Date ? at.getTime() : NaN;

  if (!Number.isNaN(when) && (s.lastInbound === null || when > s.lastInbound)) {
    s.lastInbound = when;
  }

  const keyword = normalize(text);
  if (STOP_WORDS.has(keyword)) {
    s.optedOut = true;
  } else if (START_WORDS.has(keyword)) {
    s.optedOut = false;
  }
}

export function check(userId, type, now) {
  if (type !== 'freeform' && type !== 'template') {
    return { allowed: false, rule: 'invalid_type' };
  }

  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (Number.isNaN(nowMs)) {
    return { allowed: false, rule: 'invalid_time' };
  }

  const s = states.get(userId);

  if (s && s.optedOut) {
    return { allowed: false, rule: 'opted_out' };
  }

  if (!s || s.lastInbound === null) {
    return { allowed: false, rule: 'no_prior_inbound' };
  }

  if (type === 'freeform') {
    const elapsed = nowMs - s.lastInbound;
    if (elapsed < 0 || elapsed >= WINDOW_MS) {
      return { allowed: false, rule: 'freeform_window_closed' };
    }
  }

  return { allowed: true, rule: null };
}
