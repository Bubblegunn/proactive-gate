import * as k from "./kit.mjs";
import fs from "node:fs";
const pts = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = pts.map((p) => {
  try {
    if (p.op === "local") { const l = k.gkLocal(p.t, p.zone); return [l.y, l.m, l.d, l.hh, l.mm, l.dow]; }
    if (p.op === "day") return [k.gkDayKey(p.t, p.zone), k.gkWeekKey(p.t, p.zone), k.gkMonthKey(p.t, p.zone)];
    if (p.op === "mid") return k.gkNextMidnight(p.t, p.zone);
    if (p.op === "open") return k.gkNextOpen(p.t, p.zone, p.s, p.e);
    if (p.op === "in") return k.gkInWindow(p.t, p.zone, p.s, p.e);
    if (p.op === "inst") return k.gkInstant(p.y, p.m, p.d, p.hh, p.mm, p.zone);
  } catch (e) { return "ERR " + e.message; }
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
