process.env.TZ = "UTC";
import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const r = new Report();
const fresh = () => join(mkdtempSync(join(tmpdir(), "d4-")), "state");
const T = "2026-06-10T10:00:00Z";
const ev = (email, type) => ({ fn: "recordEvent", args: [{ email, type, now: { $date: T } }] });
const ck = (email, kind) => ({ fn: "checkEmail", args: [{ email, kind, now: { $date: T } }] });
const ok = (x) => !!x && x.allowed === true;
const no = (x) => !!x && x.allowed === false;

await r.crit("1 marketing stops after an unsubscribe or a spam complaint, other addresses are unaffected", async (why) => {
  const res = await runProc(dir, fresh(), [
    ck("ann@example.com", "marketing"), ev("ann@example.com", "unsubscribe"), ev("bob@example.com", "spam_complaint"),
    ck("ann@example.com", "marketing"), ck("bob@example.com", "marketing"), ck("cy@example.com", "marketing"),
  ]);
  if (!ok(res[0])) { why("control blocked"); return false; }
  if (!no(res[3]) || !no(res[4])) { why("not blocked after event: " + JSON.stringify(res.slice(3, 5))); return false; }
  if (typeof res[3].rule !== "string" || !res[3].rule) { why("no rule"); return false; }
  if (!ok(res[5])) { why("other address blocked"); return false; }
  return true;
});
await r.crit("2 receipts and other transactional mail still go to someone who unsubscribed or complained", async (why) => {
  const res = await runProc(dir, fresh(), [
    ev("ann@example.com", "unsubscribe"), ev("bob@example.com", "spam_complaint"),
    ck("ann@example.com", "transactional"), ck("bob@example.com", "transactional"),
  ]);
  if (!ok(res[2]) || !ok(res[3])) { why(JSON.stringify(res.slice(2))); return false; }
  return true;
});
await r.crit("3 a hard bounce stops all mail to that address, marketing and transactional", async (why) => {
  const res = await runProc(dir, fresh(), [
    ev("gone@example.com", "hard_bounce"), ck("gone@example.com", "marketing"), ck("gone@example.com", "transactional"), ck("here@example.com", "transactional"),
  ]);
  if (!no(res[1]) || !no(res[2])) { why(JSON.stringify(res.slice(1, 3))); return false; }
  if (!ok(res[3])) { why("other address blocked"); return false; }
  return true;
});
await r.crit("4 the same address in other capitals or with spaces is the same recipient", async (why) => {
  const res = await runProc(dir, fresh(), [
    ev("  Ann.Lee@Example.COM ", "unsubscribe"),
    ck("ann.lee@example.com", "marketing"), ck("ANN.LEE@EXAMPLE.COM", "marketing"), ck(" ann.lee@example.com", "marketing"),
  ]);
  if (!res.slice(1).every(no)) { why(JSON.stringify(res.slice(1))); return false; }
  return true;
});
await r.crit("5 a suppression recorded in one process is seen by a later process", async (why) => {
  const st = fresh();
  await runProc(dir, st, [ev("ann@example.com", "unsubscribe"), ev("gone@example.com", "hard_bounce")]);
  const res = await runProc(dir, st, [ck("ann@example.com", "marketing"), ck("gone@example.com", "marketing")]);
  if (!no(res[0]) || !no(res[1])) { why(JSON.stringify(res)); return false; }
  return true;
});
await r.crit("6 events recorded at the same moment by three processes are all kept", async (why) => {
  const st = fresh();
  const addrs = Array.from({ length: 18 }, (_, i) => `user${i}@example.com`);
  await Promise.all([0, 1, 2].map((p) => runProc(dir, st, addrs.filter((_, i) => i % 3 === p).map((a) => ev(a, "unsubscribe")), true)));
  const res = await runProc(dir, st, addrs.map((a) => ck(a, "marketing")));
  const lost = res.map((x, i) => (ok(x) ? addrs[i] : null)).filter(Boolean);
  if (lost.length) { why("lost: " + lost.length); return false; }
  return true;
});
r.print();
