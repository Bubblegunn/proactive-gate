import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(fn) {
  fs.mkdirSync(process.env.STATE_DIR, { recursive: true });
  const lock = path.join(process.env.STATE_DIR, "lock");
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - t0 > 5000) { try { fs.rmdirSync(lock); } catch {} }
      sleep(2);
    }
  }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}
const db = () => path.join(process.env.STATE_DIR, "slots.json");
const load = () => { try { return JSON.parse(fs.readFileSync(db(), "utf8")); } catch { return []; } };
const save = (x) => { fs.writeFileSync(db() + ".tmp", JSON.stringify(x)); fs.renameSync(db() + ".tmp", db()); };
export function reserve(req, now) {
  return withLock(() => {
    const all = load();
    const t = now.getTime();
    const mine = all.filter((s) => s.userId === req.userId);
    const inWin = mine.filter((s) => s.t > t - req.windowHours * 3600000);
    const deny = (reason) => { all.push({ id: "denied-" + crypto.randomUUID(), userId: req.userId, t }); save(all); return { allowed: false, reason, reservationId: null }; };
    if (inWin.length >= req.maxPerWindow) return deny("window_limit");
    if (mine.some((s) => t - s.t < req.minGapMinutes * 60000 && s.t <= t)) return deny("min_gap");
    const id = crypto.randomUUID();
    all.push({ id, userId: req.userId, t });
    save(all);
    return { allowed: true, reason: null, reservationId: id };
  });
}
export function release(id) {
  return withLock(() => { save(load().filter((s) => s.id !== id)); });
}
