// Stub of the vendor client. The real vendor drops a second call that carries an
// Idempotency-Key it has already seen (within 24h) and returns the original providerId.
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
const out = new URL('./out/', import.meta.url);
export async function send(message, { idempotencyKey } = {}) {
  mkdirSync(out, { recursive: true });
  const file = new URL('sent.jsonl', out);
  if (idempotencyKey && existsSync(file)) {
    const seen = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.idempotencyKey === idempotencyKey);
    if (seen) return { providerId: seen.providerId, deduped: true };
  }
  const providerId = 'stub-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  appendFileSync(file, JSON.stringify({ ...message, idempotencyKey, providerId }) + '\n');
  return { providerId };
}
