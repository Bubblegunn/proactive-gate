import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = resolve(process.argv[2]);
const r = new Report();
const newState = () => join(mkdtempSync(join(tmpdir(), "q4-")), "state");
const D = (iso) => ({ $date: iso });
const T = "2026-05-04T15:00:00Z";
const inb = (from, body) => ({ fn: "handleInbound", args: [{ from, body, receivedAt: D(T) }] });
const can = (p) => ({ fn: "canText", args: [p, D("2026-05-04T15:30:00Z")] });
const num = (i) => "+1415555" + String(1000 + i);

await r.crit("1 every standard stop word opts the sender out and gets a reply", async (why) => {
  const words = ["STOP", "stop", "  Stop \n", "STOPALL", "Unsubscribe", "CANCEL", "end", "QUIT"];
  const s = newState();
  const plan = [];
  words.forEach((w, i) => plan.push(inb(num(i), w)));
  words.forEach((w, i) => plan.push(can(num(i))));
  const out = await runProc(dir, s, plan);
  for (let i = 0; i < words.length; i++) {
    const a = out[i], c = out[words.length + i];
    if (!a || a.error || a.action !== "opt_out") { why(`${JSON.stringify(words[i])} -> ${JSON.stringify(a)}`); return false; }
    if (typeof a.reply !== "string" || !a.reply.trim()) { why(`no confirmation reply for ${JSON.stringify(words[i])}`); return false; }
    if (!c || c.allowed !== false) { why(`still allowed after ${JSON.stringify(words[i])}`); return false; }
  }
  return true;
});

await r.crit("2 ordinary sentences containing those words do not opt out", async (why) => {
  const bodies = ["Please don't stop the reminders", "Can I cancel my 3pm appointment?", "endless thanks!", "ok thanks", "stopwatch", "", "I will quit smoking soon"];
  const s = newState();
  const plan = bodies.map((b, i) => inb(num(i), b)).concat(bodies.map((b, i) => can(num(i))));
  const out = await runProc(dir, s, plan);
  for (let i = 0; i < bodies.length; i++) {
    if (out[i].error) { why("threw on " + JSON.stringify(bodies[i]) + ": " + out[i].error); return false; }
    if (out[i].action === "opt_out") { why("opted out on " + JSON.stringify(bodies[i])); return false; }
    if (out[bodies.length + i].allowed !== true) { why("blocked after " + JSON.stringify(bodies[i])); return false; }
  }
  return true;
});

await r.crit("3 an opt-out in one process is seen by other and later processes", async (why) => {
  const s = newState();
  await runProc(dir, s, [inb(num(1), "STOP")]);
  const b = await runProc(dir, s, [can(num(1)), can(num(2))]);
  if (b[0].allowed !== false) { why("opted-out number allowed in second process"); return false; }
  if (b[1].allowed !== true) { why("other number blocked"); return false; }
  const c = await runProc(dir, s, [can(num(1))]);
  if (c[0].allowed !== false) { why("opt-out lost in third process"); return false; }
  if (b[0].reason === "ok" || !b[0].reason) { why("blocked without a reason"); return false; }
  return true;
});

await r.crit("4 the same number in any North American format is the same person", async (why) => {
  const s = newState();
  const fm = ["(415) 555-0100", "415-555-0100", "+1 415 555 0100", "14155550100", "1-415-555-0100", "+14155550100", "415.555.0100"];
  const out = await runProc(dir, s, [inb("+14155550100", "STOP"), ...fm.map(can), can("(415) 555-0101"), can("+12125550100")]);
  for (let i = 0; i < fm.length; i++) if (out[1 + i].allowed !== false) { why(`format ${fm[i]} still allowed`); return false; }
  if (out[1 + fm.length].allowed !== true) { why("neighbouring number blocked"); return false; }
  if (out[2 + fm.length].allowed !== true) { why("same digits, other area code blocked"); return false; }
  return true;
});

await r.crit("5 START re-subscribes, a later STOP stops again, HELP changes nothing", async (why) => {
  const s = newState();
  const p = num(7), q = num(8);
  const out = await runProc(dir, s, [inb(p, "STOP"), can(p), inb(p, "help"), can(p), inb(p, "START"), can(p), inb(p, "STOP"), can(p), inb(q, "HELP"), can(q)]);
  const al = (i) => out[i].allowed;
  if (al(1) !== false) { why("not blocked after STOP"); return false; }
  if (out[2].action !== "help" || typeof out[2].reply !== "string" || !out[2].reply.trim()) { why("HELP reply " + JSON.stringify(out[2])); return false; }
  if (al(3) !== false) { why("HELP re-subscribed the number"); return false; }
  if (out[4].action !== "opt_in" || al(5) !== true) { why("START did not re-subscribe " + JSON.stringify([out[4], out[5]])); return false; }
  if (al(7) !== false) { why("second STOP ignored"); return false; }
  if (al(9) !== true) { why("HELP blocked a number"); return false; }
  return true;
});

await r.crit("6 simultaneous opt-outs from several processes are all kept", async (why) => {
  const s = newState();
  const outs = await Promise.all([0, 1, 2, 3].map((w) => runProc(dir, s, Array.from({ length: 6 }, (_, k) => inb(num(100 + w * 6 + k), "STOP")), true)));
  for (const o of outs) if (o.some((x) => x.error)) { why("error " + o.find((x) => x.error).error); return false; }
  const plan = Array.from({ length: 24 }, (_, i) => can(num(100 + i))).concat([can(num(500))]);
  const out = await runProc(dir, s, plan);
  const lost = out.slice(0, 24).map((x, i) => (x.allowed === true ? i : -1)).filter((i) => i >= 0);
  if (lost.length) { why("lost opt-outs for #" + lost.join(",")); return false; }
  if (out[24].allowed !== true) { why("control number blocked"); return false; }
  return true;
});
r.print();
