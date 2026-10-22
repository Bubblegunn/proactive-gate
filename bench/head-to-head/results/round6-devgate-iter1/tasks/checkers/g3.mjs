import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
const dir = resolve(process.argv[2]);
const r = new Report();
const $d = (iso) => ({ $date: iso });
const fresh = () => join(mkdtempSync(join(tmpdir(), "g3-")), "not-created-yet", "state");
const may = (to, kind = "marketing", now = "2026-02-01T00:00:00Z") => ({ fn: "mayEmail", args: [{ to, kind }, $d(now)] });
const unsub = (e, at = "2026-01-10T10:00:00Z") => ({ fn: "recordUnsubscribe", args: [e, $d(at)] });
const resub = (e, at) => ({ fn: "recordResubscribe", args: [e, $d(at)] });
const blocked = (x) => x && x.allowed === false && typeof x.reason === "string" && x.reason.length > 0;
const allowed = (x) => x && x.allowed === true && x.reason === null;

await r.crit("1 an unsubscribe seen by one process blocks marketing in another process", async (why) => {
  const s = fresh();
  await runProc(dir, s, [unsub("pat@example.com")]);
  const [a, b] = await runProc(dir, s, [may("pat@example.com"), may("other@example.com")]);
  if (!blocked(a) || !allowed(b)) { why(JSON.stringify([a, b])); return false; }
  return true;
});
await r.crit("2 the same person is matched regardless of letter case and surrounding spaces", async (why) => {
  const s = fresh();
  await runProc(dir, s, [unsub("  Jane.Doe@Example.COM ")]);
  const [a, b, c] = await runProc(dir, s, [may("jane.doe@example.com"), may("JANE.DOE@EXAMPLE.COM"), may("jane.doe@example.org")]);
  if (!blocked(a) || !blocked(b) || !allowed(c)) { why(JSON.stringify([a, b, c])); return false; }
  return true;
});
await r.crit("3 order receipts and resets (transactional) still go to unsubscribed people", async (why) => {
  const s = fresh();
  await runProc(dir, s, [unsub("pat@example.com")]);
  const [a, b] = await runProc(dir, s, [may("pat@example.com", "transactional"), may("pat@example.com", "marketing")]);
  if (!allowed(a) || !blocked(b)) { why(JSON.stringify([a, b])); return false; }
  return true;
});
await r.crit("4 unsubscribes recorded at the same moment by several processes are all kept", async (why) => {
  const s = fresh();
  const mkPlan = (p) => Array.from({ length: 25 }, (_, i) => unsub(`user${p}-${i}@example.com`, `2026-01-10T10:00:${String(i).padStart(2, "0")}Z`));
  await Promise.all([0, 1, 2].map((p) => runProc(dir, s, mkPlan(p), true)));
  const checks = [];
  for (let p = 0; p < 3; p++) for (let i = 0; i < 25; i++) checks.push(may(`user${p}-${i}@example.com`));
  const res = await runProc(dir, s, checks);
  const lost = res.filter((x) => !blocked(x)).length;
  if (lost) { why(lost + " of 75 unsubscribes were lost"); return false; }
  return true;
});
await r.crit("5 a later resubscribe lifts the block for that person only", async (why) => {
  const s = fresh();
  await runProc(dir, s, [unsub("a@example.com"), unsub("b@example.com")]);
  await runProc(dir, s, [resub("a@example.com", "2026-01-20T10:00:00Z")]);
  const [a, b] = await runProc(dir, s, [may("a@example.com"), may("b@example.com")]);
  if (!allowed(a) || !blocked(b)) { why(JSON.stringify([a, b])); return false; }
  return true;
});
await r.crit("6 a resubscribe event that is older than the unsubscribe does not lift the block", async (why) => {
  const s = fresh();
  await runProc(dir, s, [unsub("a@example.com", "2026-01-20T10:00:00Z")]);
  await runProc(dir, s, [resub("a@example.com", "2026-01-05T10:00:00Z")]); // arrives late
  const [a] = await runProc(dir, s, [may("a@example.com")]);
  // and the reverse arrival order: newer resubscribe arrives first, older unsubscribe arrives after
  const s2 = fresh();
  await runProc(dir, s2, [resub("c@example.com", "2026-01-20T10:00:00Z")]);
  await runProc(dir, s2, [unsub("c@example.com", "2026-01-05T10:00:00Z")]);
  const [c] = await runProc(dir, s2, [may("c@example.com")]);
  if (!blocked(a) || !allowed(c)) { why(JSON.stringify([a, c])); return false; }
  return true;
});
r.print();
