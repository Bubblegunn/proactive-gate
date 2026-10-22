// Decides whether one SMS may be sent now. Pure check: sends nothing, keeps no state.
// Marketing texts follow 47 CFR 64.1200(c)(1): 08:00 to 21:00 at the called party's local time.
// Transactional texts have no time window under the rules named in the request.

const MARKETING_START_MINUTE = 8 * 60; // 08:00 local, included
const MARKETING_END_MINUTE = 21 * 60; // 21:00 local, excluded

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function refuse(reason) {
  return { allowed: false, reason };
}

// Minute of the day at `now` in `timeZone`, or null when the zone is missing or unknown.
function localMinuteOfDay(now, timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
  } catch {
    return null;
  }
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

// 'none' when null, 'opted_out' when a valid ISO timestamp, 'unknown' for anything else.
function optOutState(optedOutAt) {
  if (optedOutAt === null) return 'none';
  if (typeof optedOutAt === 'string' && ISO_8601.test(optedOutAt) && !Number.isNaN(Date.parse(optedOutAt))) {
    return 'opted_out';
  }
  return 'unknown';
}

export function checkSms(message, now) {
  const { kind, to } = message ?? {};

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return refuse('invalid_now');
  if (kind !== 'marketing' && kind !== 'transactional') return refuse('unknown_kind');
  if (!to || typeof to !== 'object') return refuse('invalid_recipient');

  // A STOP applies to every text from us to this customer, not only marketing.
  const optOut = optOutState(to.optedOutAt);
  if (optOut === 'opted_out') return refuse('opted_out');
  if (optOut === 'unknown') return refuse('opt_out_status_unknown');

  if (kind === 'transactional') return { allowed: true, reason: null };

  if (to.marketingConsent !== true) return refuse('no_marketing_consent');

  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute === null) return refuse('invalid_time_zone');
  if (minute < MARKETING_START_MINUTE || minute >= MARKETING_END_MINUTE) {
    return refuse('outside_marketing_hours');
  }

  return { allowed: true, reason: null };
}
