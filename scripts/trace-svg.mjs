#!/usr/bin/env node
/**
 * Draws docs/assets/trace.svg from a real replay: two decisions from examples/day.jsonl
 * under examples/policy.json, one rejected and one allowed, every line taken verbatim
 * from the CLI's --json output. Re-run after changing the checks, the policy or the
 * example day:
 *
 *   node scripts/trace-svg.mjs [rejectedId] [allowedId]   (defaults a1 a5)
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [rejectedId = "a1", allowedId = "a5"] = process.argv.slice(2);

const run = spawnSync(process.execPath, ["dist/src/cli.js", "replay", "examples/day.jsonl", "--policy", "examples/policy.json", "--commit", "--json"], { cwd: root, encoding: "utf8" });
if (run.status !== 0) throw new Error(run.stderr || "replay failed; run npm run build first");
const decisions = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
const pick = (id) => {
  const d = decisions.find((x) => x.candidateId === id);
  if (!d) throw new Error(`no decision for candidate ${id}`);
  return d;
};
const left = pick(rejectedId);
const right = pick(allowedId);
if (left.allowed || !right.allowed) throw new Error(`expected ${rejectedId} rejected and ${allowedId} allowed`);

const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const COLOR = { ink: "#111111", muted: "#6b6b6b", rule: "#e2e2e2", pass: "#1b6e3a", reject: "#b3261e", skip: "#8a6d00", panel: "#fafafa" };
const size = 13;
const lineHeight = 20;
const pad = 18;
const panelWidth = 470;
const gap = 20;
const width = pad * 2 + panelWidth * 2 + gap;
const wrapAt = 54;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wrap = (text, at) => {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if ((line + " " + word).trim().length > at && line) { out.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
};
const mark = (outcome) => (outcome === "pass" ? "✓" : outcome === "reject" ? "✗" : outcome === "defer" ? "…" : outcome === "adjust" ? "~" : "·");

function panel(decision, x) {
  const lines = [];
  const verdict = decision.allowed ? `allowed → ${decision.surfaces.join(", ")}` : `rejected by ${decision.rejectedBy}`;
  lines.push({ text: `candidate ${decision.candidateId}   user ${decision.userId}   ${decision.evaluatedAt.replace(".000Z", "Z")}`, color: COLOR.muted });
  lines.push({ text: verdict, color: decision.allowed ? COLOR.pass : COLOR.reject, bold: true });
  lines.push({ text: "", color: COLOR.ink });
  for (const step of decision.trace) {
    const color = step.outcome === "pass" ? COLOR.pass : step.outcome === "reject" ? COLOR.reject : COLOR.skip;
    const ms = `${step.ms} ms`;
    lines.push({ text: `${mark(step.outcome)} ${step.id.padEnd(18)} ${step.outcome.padEnd(7)} ${ms.padStart(9)}`, color });
    if (step.reason) for (const piece of wrap(step.reason, wrapAt)) lines.push({ text: `    ${piece}`, color: COLOR.muted });
  }
  const height = pad + lines.length * lineHeight + pad / 2;
  let svg = `<rect x="${x}" y="${pad}" width="${panelWidth}" height="${height}" rx="4" fill="${COLOR.panel}" stroke="${COLOR.rule}"/>`;
  lines.forEach((line, i) => {
    if (!line.text) return;
    const y = pad + pad + (i + 0.75) * lineHeight;
    svg += `<text x="${x + 14}" y="${y.toFixed(1)}" fill="${line.color}"${line.bold ? ' font-weight="600"' : ""} xml:space="preserve">${esc(line.text)}</text>`;
  });
  return { svg, height };
}

const l = panel(left, pad);
const r = panel(right, pad + panelWidth + gap);
const height = pad * 2 + Math.max(l.height, r.height) + lineHeight;
const caption = `proactive-gate replay examples/day.jsonl --policy examples/policy.json --commit --json`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="${size}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
${l.svg}
${r.svg}
<text x="${pad}" y="${height - 10}" fill="${COLOR.muted}" font-size="11">${esc(caption)}</text>
</svg>
`;
writeFileSync(new URL("../docs/assets/trace.svg", import.meta.url), svg);
console.log(`docs/assets/trace.svg: ${left.candidateId} (${left.rejectedBy}) and ${right.candidateId} (allowed), ${width}x${height}`);
