// Reference for Y6, Node. Reads policy.json from the current folder and the case file named in argv[2].
// Rules, the first that applies wins: requireConsent and no consent -> consent; normal case inside local quiet hours
// (start inclusive, end exclusive, may cross midnight) -> quiet; the user already has dailyCap sent calls on the same
// local day in the case's timezone -> cap; otherwise sent. A null quietHours or dailyCap disables that rule.
import { readFileSync } from "node:fs";

let policy;
try {
  policy = JSON.parse(readFileSync("policy.json", "utf8"));
} catch (e) {
  process.stderr.write(`policy.json is missing or not valid JSON: ${e.message}\n`);
  process.exit(1);
}
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));

const fmts = new Map();
function localOf(at, timeZone) {
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
  for (const x of fmts.get(timeZone).formatToParts(new Date(at))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const quiet = policy.quietHours ? { start: toMinutes(policy.quietHours.start), end: toMinutes(policy.quietHours.end) } : null;
const inQuiet = (minute) => (quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end);

const counts = new Map();
const out = cases.map((c, index) => {
  const { day, minute } = localOf(c.at, c.timezone);
  let outcome;
  if (policy.requireConsent && !c.consent) outcome = "consent";
  else if (quiet && c.priority !== "critical" && inQuiet(minute)) outcome = "quiet";
  else {
    const key = `${c.userId}|${day}`;
    const n = counts.get(key) ?? 0;
    if (policy.dailyCap !== null && n >= policy.dailyCap) outcome = "cap";
    else {
      outcome = "sent";
      counts.set(key, n + 1);
    }
  }
  return { index, outcome };
});
process.stdout.write(JSON.stringify(out) + "\n");
