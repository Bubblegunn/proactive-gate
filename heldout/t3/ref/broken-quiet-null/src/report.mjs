import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { compareWeek } from './replay.mjs';
const root = new URL('../', import.meta.url);
const rj = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const rl = p => readFileSync(new URL(p, root), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const [basePath, propPath] = process.argv.slice(2);
if (!basePath || !propPath) { console.error('usage: node src/report.mjs <baseline-policy.json> <proposed-policy.json>'); process.exit(2); }
const r = compareWeek({ candidates: rl('data/candidates.jsonl'), events: rl('data/events.jsonl'), history: rl('data/history-before.jsonl'), users: rj('data/users.json'), areaCodes: rj('data/area-codes.json'), baselinePolicy: JSON.parse(readFileSync(basePath, 'utf8')), proposedPolicy: JSON.parse(readFileSync(propPath, 'utf8')) });
mkdirSync(new URL('out/', root), { recursive: true });
writeFileSync(new URL('out/per-message.jsonl', root), r.messages.map(m => JSON.stringify({ id: m.id, outcome: m.proposed.outcome, reasons: m.proposed.reasons, baselineOutcome: m.baseline.outcome })).join('\n') + '\n');
const L = [];
L.push(`Messages replayed: ${r.total} (${r.duplicatesDropped} duplicate rows dropped)`);
L.push(`Current policy: sent ${r.baseline.sent}, blocked ${r.baseline.blocked}`);
L.push(`Proposed policy: sent ${r.proposed.sent}, blocked ${r.proposed.blocked}`);
L.push('Blocked under proposed policy, by first reason:');
for (const [k, v] of Object.entries(r.proposed.byReason).sort((a, b) => b[1] - a[1])) L.push(`  ${k}: ${v}`);
L.push(`Newly blocked: ${r.newlyBlocked.length}, newly allowed: ${r.newlyAllowed.length}`);
console.log(L.join('\n'));
