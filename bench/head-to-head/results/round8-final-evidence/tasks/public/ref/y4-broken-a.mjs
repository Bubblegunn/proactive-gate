// Broken A for Y4. Mistake 1: the records live in a module-level array, so every process starts empty. A delivery made
// by one process is invisible to the next process and to whyNothing, and the daily cap is not shared between workers.
// Mistake 2: whyNothing treats `to` as inclusive, so a call made exactly at the upper bound is counted.
// The checker runs every call in its own process, so mistake 1 alone breaks all six criteria; mistake 2 is visible
// only in the range checks of criterion 3 and is masked there by the empty state.
// Expected FAILS: 1, 2, 3, 4, 5, 6 (the score is 0/6 for this reason).
const records = [];
const CAP = 2;
const REASON = {
  consent: "The user has not given consent.",
  quietHours: "The message falls within quiet hours (22:00 to 07:00 local time).",
  dailyCap: "The daily limit of 2 delivered messages for this local day has been reached.",
};
const PHRASE = { consent: "consent", quietHours: "quiet hours", dailyCap: "daily limit" };

const fmts = new Map();
function local(date, timeZone) {
  if (!fmts.has(timeZone)) {
    fmts.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  const p = {};
  for (const x of fmts.get(timeZone).formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export async function deliver({ user, message, now }) {
  const at = new Date(now);
  const { day, minute } = local(at, user.timezone);
  let rule = null;
  if (!user.consent) rule = "consent";
  else if (minute >= 22 * 60 || minute < 7 * 60) rule = "quietHours";
  else if (records.filter((r) => r.userId === user.id && r.day === day && r.delivered).length >= CAP) rule = "dailyCap";
  records.push({ userId: user.id, messageId: message.id, atMs: at.getTime(), day, delivered: rule === null, rule });
  return { delivered: rule === null, rule };
}

export async function whyNothing({ userId, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const rows = records.filter((r) => r.userId === userId && r.atMs >= fromMs && r.atMs <= toMs);
  let delivered = 0;
  const blocked = [];
  const byRule = {};
  for (const r of rows) {
    if (r.delivered) delivered++;
    else {
      blocked.push({ messageId: r.messageId, at: new Date(r.atMs).toISOString(), rule: r.rule, reason: REASON[r.rule] });
      byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
    }
  }
  let verdict;
  if (rows.length === 0) verdict = "There were no messages for this user in this range.";
  else if (delivered === 0) {
    const top = Object.entries(byRule).sort((a, b) => b[1] - a[1])[0][0];
    verdict = `Nothing was delivered: ${blocked.length} messages were blocked, most of them by ${PHRASE[top]}.`;
  } else verdict = `${delivered} messages were delivered in this range.`;
  return { delivered, blocked, byRule, verdict };
}
