import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { evaluate } from './gate.mjs';
import { send } from '../send.mjs';
const root = new URL('../', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const lines = p => readFileSync(new URL(p, root), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const users = new Map(json('data/users.json').map(u => [u.id, u]));
const policy = json('data/policy.json'), areaCodes = json('data/area-codes.json');
const history = lines('data/history-before.jsonl');
const cands = lines('data/candidates.jsonl').sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
mkdirSync(new URL('out/', root), { recursive: true });
rmSync(new URL('out/sent.jsonl', root), { force: true });
const blocked = [];
for (const c of cands) {
  const user = users.get(c.userId);
  if (!user) continue;
  const r = evaluate(c, { user, policy, areaCodes, history });
  if (r.allowed) { await send(c); history.push({ id: c.id, userId: c.userId, channel: c.channel, at: c.at, status: 'sent' }); }
  else blocked.push({ id: c.id, reasons: r.reasons, retryAt: r.retryAt });
}
writeFileSync(new URL('out/blocked.jsonl', root), blocked.map(b => JSON.stringify(b)).join('\n') + (blocked.length ? '\n' : ''));
