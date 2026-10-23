import * as api from "../../../../dist/src/index.js";
import fs from "node:fs";
const pts = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).filter((p) => p.op === "open" && p.s === "08:00");
const gate = api.createGate({ policy: { specVersion: "1.0.0", checks: [{ preset: "usTcpa" }] }, store: new api.MemoryStore() });
const out = [];
let n = 0;
for (const p of pts) {
  const d = await gate.evaluate({ user: { id: "u" + n, consent: true, timezone: p.zone }, candidate: { id: "c" + n++, type: "x", channel: "sms" }, now: new Date(p.t) });
  out.push({ t: p.t, zone: p.zone, allowed: d.allowed, next: d.nextAllowedAt ? d.nextAllowedAt.getTime() : null });
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
