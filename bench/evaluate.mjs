// Measures gate.evaluate() with the default twelve checks and MemoryStore.
// Run: npm run bench   (builds first). Prints median and p95 in microseconds.
import { createGate, defaultChecks, MemoryStore } from "../dist/src/index.js";
import { cpus } from "node:os";

const gate = createGate({ store: new MemoryStore(), checks: defaultChecks({ dailyLimit: 5 }) });
const user = {
  id: "u1", consent: true, proactiveEnabled: true, mode: "normal", intensity: "normal",
  timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" }, createdAt: "2026-01-01T00:00:00Z",
};
const now = new Date("2026-09-04T09:00:00Z");
const N = 10_000;
const samples = new Float64Array(N);

// warm up
for (let i = 0; i < 500; i++) await gate.evaluate({ user, candidate: { id: `w${i}`, type: "reminder", priority: "normal", surfaces: ["push"] }, now });

for (let i = 0; i < N; i++) {
  const candidate = { id: `c${i}`, type: i % 3 ? "reminder" : "insight", priority: "normal", surfaces: ["push", "feed"] };
  const t0 = performance.now();
  await gate.evaluate({ user, candidate, now });
  samples[i] = (performance.now() - t0) * 1000;
}
const sorted = Array.from(samples).sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log(`evaluate() x ${N.toLocaleString("en-US")}, twelve checks, MemoryStore: median ${q(0.5).toFixed(1)} µs, p95 ${q(0.95).toFixed(1)} µs (${process.version}, ${cpus()[0].model})`);
