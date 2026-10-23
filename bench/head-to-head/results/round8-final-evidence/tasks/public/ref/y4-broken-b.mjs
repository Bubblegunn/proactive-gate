// Broken B for Y4. Mistake 1: the deliver read-modify-write on a JSON file has an await between the read and the
// write, so concurrent calls read the same counts and the cap is raced past, and records are lost when two writers
// overwrite each other. Mistake 2: the cap is checked before quiet hours, so a quiet-hours block that is also over
// the cap is reported as dailyCap. Mistake 3: the verdict names the first rule in arrival order instead of the rule
// with the most blocked messages.
// Expected FAILS: 1 (the quiet-and-over-cap case reports dailyCap), 2 (u3 and u2 byRule and the verdict), 3 (the
// verdict of the 11:00Z to 04:00Z range names dailyCap), 5 (the racy writes break the cap and the counts).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CAP = 2;
const REASON = {
  consent: "The user has not given consent.",
  quietHours: "The message falls within quiet hours (22:00 to 07:00 local time).",
  dailyCap: "The daily limit of 2 delivered messages for this local day has been reached.",
};
const PHRASE = { consent: "consent", quietHours: "quiet hours", dailyCap: "daily limit" };

const file = () => join(process.env.STATE_DIR, "records.json");
function read() {
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  if (!existsSync(file())) return [];
  return JSON.parse(readFileSync(file(), "utf8"));
}

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
  const records = read();
  await new Promise((resolve) => setTimeout(resolve, 1));
  let rule = null;
  if (!user.consent) rule = "consent";
  else if (records.filter((r) => r.userId === user.id && r.day === day && r.delivered).length >= CAP) rule = "dailyCap";
  else if (minute >= 22 * 60 || minute < 7 * 60) rule = "quietHours";
  records.push({ userId: user.id, messageId: message.id, atMs: at.getTime(), day, delivered: rule === null, rule });
  writeFileSync(file(), JSON.stringify(records));
  return { delivered: rule === null, rule };
}

export async function whyNothing({ userId, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const rows = read()
    .filter((r) => r.userId === userId && r.atMs >= fromMs && r.atMs < toMs)
    .sort((a, b) => a.atMs - b.atMs);
  let delivered = 0;
  const blocked = [];
  const byRule = {};
  const order = [];
  for (const r of rows) {
    if (r.delivered) delivered++;
    else {
      blocked.push({ messageId: r.messageId, at: new Date(r.atMs).toISOString(), rule: r.rule, reason: REASON[r.rule] });
      byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
      if (!order.includes(r.rule)) order.push(r.rule);
    }
  }
  let verdict;
  if (rows.length === 0) verdict = "There were no messages for this user in this range.";
  else if (delivered === 0) verdict = `Nothing was delivered: ${blocked.length} messages were blocked, most of them by ${PHRASE[order[0]]}.`;
  else verdict = `${delivered} messages were delivered in this range.`;
  return { delivered, blocked, byRule, verdict };
}
