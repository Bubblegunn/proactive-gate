// Follow-up gate for the customer-support assistant. In-memory only.
//
// Rules, in the order check() applies them:
//   1. type must be "freeform" or "template".
//   2. opted-out: the customer's latest STOP-type message (by `at`) is newer
//      than their latest START-type message. Blocks both types.
//   3. freeform only: needs a customer message within the last 24 hours
//      (WhatsApp customer service window). Without it, only templates may be sent.
//
// Templates are not gated by the window, so they can reach customers who have
// never written to us, as long as they have not opted out.

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Carrier (CTIA) opt-out keywords. Matched against the whole message only.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
// Opt-in keywords used to restart a program.
const START_WORDS = new Set(['start', 'unstop']);
// Plain-language opt-outs such as "please stop texting me". Whole message only.
const STOP_PHRASE = /^(please )?(stop|unsubscribe|quit)( (texting|messaging|sending|contacting) me)?( please)?$/;

const customers = new Map(); // userId -> { lastInboundAt: ms | null, consent: { at: ms, kind: 'stop' | 'start' } | null }

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '') // zero-width and other invisible characters
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation, emoji, extra spaces
    .trim();
}

function classify(text) {
  const t = normalize(text);
  if (STOP_WORDS.has(t) || STOP_PHRASE.test(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  return null;
}

function allowed() {
  return { allowed: true, rule: null };
}

function blocked(rule) {
  return { allowed: false, rule };
}

export function onInbound(userId, text, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('onInbound: at must be a valid Date');
  }
  const when = at.getTime();

  let s = customers.get(userId);
  if (!s) {
    s = { lastInboundAt: null, consent: null };
    customers.set(userId, s);
  }

  // Messages can arrive out of order, so keep the latest by `at`, not by arrival.
  if (s.lastInboundAt === null || when > s.lastInboundAt) {
    s.lastInboundAt = when;
  }

  const kind = classify(text);
  if (kind && (s.consent === null || when >= s.consent.at)) {
    s.consent = { at: when, kind };
  }
}

export function check(userId, type, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('check: now must be a valid Date');
  }
  if (type !== 'freeform' && type !== 'template') {
    return blocked('unknown-type');
  }

  const s = customers.get(userId);

  if (s?.consent?.kind === 'stop') {
    return blocked('opted-out');
  }
  if (type === 'template') {
    return allowed();
  }

  if (!s || s.lastInboundAt === null) {
    return blocked('no-open-window');
  }
  if (now.getTime() - s.lastInboundAt >= WINDOW_MS) {
    return blocked('window-closed');
  }
  return allowed();
}
