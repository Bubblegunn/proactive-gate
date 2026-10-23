import { deliver } from './bot.mjs';
const [u, now] = process.argv.slice(2);
let n = 0;
const transport = { push: async () => (n++, true), inApp: async () => {} };
await deliver({ user: JSON.parse(u), candidate: { id: 'same', type: 'briefing' }, now, transport, consentStore: { get: async () => ({ push: true }) } });
process.send(n); 
