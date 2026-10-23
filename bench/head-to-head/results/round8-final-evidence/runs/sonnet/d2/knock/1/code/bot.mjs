// Send gate for the assistant's push notifications.
// Promo policy: at most 3 per customer per local calendar day (customer's time zone),
// and at least 2 hours between two promos to the same customer.
// Security alerts are never limited and never counted against the promo limits.

const MAX_PROMOS_PER_DAY = 3;
const MIN_GAP_MS = 2 * 60 * 60 * 1000;
const KEEP_MS = 48 * 60 * 60 * 1000; // older promos can no longer affect the day or gap checks

const formatters = new Map();

function dayFormatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// Local calendar day ("YYYY-MM-DD") of a timestamp in the given zone. Throws RangeError on a bad zone.
function localDay(ms, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(ms));
  let y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return `${y}-${m}-${d}`;
}

export function createGate() {
  // userId -> array of { id, at } for promos that were allowed and not cancelled
  const promos = new Map();
  // id -> userId, so cancel can find the record
  const owners = new Map();
  let counter = 0;

  function deny(rule) {
    return { allowed: false, rule, id: null };
  }

  function nextId() {
    counter += 1;
    return `push-${counter}`;
  }

  function request({ userId, timeZone, category, now } = {}) {
    if (category === "security") {
      return { allowed: true, rule: "", id: nextId() };
    }
    if (category !== "promo") return deny("unknown-category");

    const at = now instanceof Date ? now.getTime() : NaN;
    if (!Number.isFinite(at)) return deny("invalid-time");

    let today;
    try {
      today = localDay(at, timeZone);
    } catch {
      return deny("invalid-time-zone");
    }

    let list = promos.get(userId);
    if (list) {
      const kept = [];
      for (const p of list) {
        if (p.at >= at - KEEP_MS) kept.push(p);
        else owners.delete(p.id);
      }
      list = kept;
      promos.set(userId, list);
    } else {
      list = [];
      promos.set(userId, list);
    }

    let todayCount = 0;
    let tooClose = false;
    for (const p of list) {
      if (localDay(p.at, timeZone) === today) todayCount += 1;
      if (Math.abs(at - p.at) < MIN_GAP_MS) tooClose = true;
    }

    if (todayCount >= MAX_PROMOS_PER_DAY) return deny("daily-cap");
    if (tooClose) return deny("min-gap");

    // Allowed means the caller sends immediately, so record it now.
    const id = nextId();
    list.push({ id, at });
    owners.set(id, userId);
    return { allowed: true, rule: "", id };
  }

  function cancel(id) {
    const userId = owners.get(id);
    if (userId === undefined) return;
    owners.delete(id);
    const list = promos.get(userId);
    if (!list) return;
    const i = list.findIndex((p) => p.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  return { request, cancel };
}
