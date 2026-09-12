// The TypeScript half of the clock sweep: render each (zone, instant) pair's local
// time through Intl, the same path `localClock` in src/checks.ts uses.
//
//   python3 bench/clock-sweep-pairs.py | node bench/clock-sweep.mjs | sort > node.txt
//   python3 bench/clock-sweep-pairs.py | python3 bench/clock-sweep.py | sort > py.txt
//   diff node.txt py.txt
//
// A diff line is an instant the two tzdb vintages disagree about.
import { readFileSync } from "node:fs";

const local = (now, timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}:${get("second")}`;
};

for (const line of readFileSync(0, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const [zone, iso] = t.split(/\s+/);
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      console.log(`${zone}\t${iso}\tINVALID`);
      continue;
    }
    console.log(`${zone}\t${iso}\t${local(d, zone)}`);
  } catch (e) {
    console.log(`${zone}\t${iso}\tTHROW ${e.constructor.name}`);
  }
}
