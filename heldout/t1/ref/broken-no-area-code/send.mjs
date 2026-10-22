import { appendFileSync, mkdirSync } from 'node:fs';
const out = new URL('./out/', import.meta.url);
export async function send(message) {
  mkdirSync(out, { recursive: true });
  appendFileSync(new URL('sent.jsonl', out), JSON.stringify({ ...message, recordedBy: 'stub' }) + '\n');
  return { providerId: 'stub-' + message.id };
}
