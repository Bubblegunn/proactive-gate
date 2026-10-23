import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSend } from './bot.mjs';

const user = (over = {}) => ({
  id: 'u1',
  timeZone: 'America/Chicago',
  sms: { optedIn: true, optedOutAt: null },
  ...over,
});
const mkt = (text = 'Sale today! Reply STOP to opt out.') => ({ kind: 'marketing', text });
const txn = { kind: 'transactional', text: 'Your order shipped.' };
const at = (iso) => new Date(iso);
const check = async (args, expected) => assert.deepEqual(await checkSend(args), expected);
const ok = { allowed: true, rule: '' };
const hold = (rule) => ({ allowed: false, rule });

test('marketing window in Chicago (CDT, UTC-5)', async () => {
  await check({ user: user(), message: mkt(), now: at('2026-10-23T12:59:00Z') }, hold('quiet-hours')); // 07:59
  await check({ user: user(), message: mkt(), now: at('2026-10-23T13:00:00Z') }, ok); // 08:00
  await check({ user: user(), message: mkt(), now: at('2026-10-24T01:59:00Z') }, ok); // 20:59
  await check({ user: user(), message: mkt(), now: at('2026-10-24T02:00:00Z') }, hold('quiet-hours')); // 21:00
});

test('daylight saving change uses the real local time', async () => {
  const u = user();
  // 2026-11-01 DST ends in Chicago; 13:00Z is 07:00 CST, 14:00Z is 08:00 CST.
  await check({ user: u, message: mkt(), now: at('2026-11-01T13:00:00Z') }, hold('quiet-hours'));
  await check({ user: u, message: mkt(), now: at('2026-11-01T14:00:00Z') }, ok);
});

test('India and Japan', async () => {
  const jp = user({ timeZone: 'Asia/Tokyo' });
  await check({ user: jp, message: mkt(), now: at('2026-10-22T22:59:00Z') }, hold('quiet-hours')); // 07:59
  await check({ user: jp, message: mkt(), now: at('2026-10-22T23:00:00Z') }, ok); // 08:00
  const inn = user({ timeZone: 'Asia/Kolkata' });
  await check({ user: inn, message: mkt(), now: at('2026-10-23T02:29:00Z') }, hold('quiet-hours')); // 07:59
  await check({ user: inn, message: mkt(), now: at('2026-10-23T02:30:00Z') }, ok); // 08:00
});

test('missing or bad time zone holds marketing, not transactional', async () => {
  const now = at('2026-10-23T18:00:00Z');
  for (const timeZone of [null, undefined, '', 'Mars/Olympus', 'UTC', 'Etc/UTC', 'EST', '+05:00', 42, {}]) {
    await check({ user: user({ timeZone }), message: mkt(), now }, hold('unknown-time-zone'));
    await check({ user: user({ timeZone }), message: txn, now }, ok);
  }
});

test('transactional ignores quiet hours', async () => {
  await check({ user: user(), message: txn, now: at('2026-10-23T08:00:00Z') }, ok); // 03:00 local
});

test('opt-out holds everything, even with optedIn true', async () => {
  const u = user({ sms: { optedIn: true, optedOutAt: '2026-10-01T10:00:00Z' } });
  const now = at('2026-10-23T18:00:00Z');
  await check({ user: u, message: mkt(), now }, hold('opted-out'));
  await check({ user: u, message: txn, now }, hold('opted-out'));
  const garbage = user({ sms: { optedIn: true, optedOutAt: 'not a date' } });
  await check({ user: garbage, message: txn, now }, hold('opted-out'));
});

test('no consent', async () => {
  const now = at('2026-10-23T18:00:00Z');
  const u = user({ sms: { optedIn: false, optedOutAt: null } });
  await check({ user: u, message: mkt(), now }, hold('no-consent'));
  await check({ user: u, message: txn, now }, hold('no-consent'));
  await check({ user: user({ sms: undefined }), message: txn, now }, hold('no-consent'));
  await check({ user: user({ sms: { optedIn: 'yes', optedOutAt: null } }), message: txn, now }, hold('no-consent'));
});

test('marketing needs opt-out wording', async () => {
  const now = at('2026-10-23T18:00:00Z');
  await check({ user: user(), message: mkt('Big sale today!'), now }, hold('no-opt-out-text'));
  await check({ user: user(), message: mkt('Big sale. Text STOP to end'), now }, ok);
  await check({ user: user(), message: { kind: 'transactional', text: 'Code 123456' }, now }, ok);
});

test('bad input never throws', async () => {
  const now = at('2026-10-23T18:00:00Z');
  await check({ user: user(), message: txn, now: new Date('nope') }, hold('invalid-input'));
  await check({ user: user(), message: txn, now: Date.now() }, hold('invalid-input'));
  await check({ user: null, message: txn, now }, hold('invalid-input'));
  await check({ user: user(), message: null, now }, hold('invalid-input'));
  await check({ user: user(), message: { kind: 'promo', text: 'x' }, now }, hold('invalid-message-kind'));
  await check({ user: user(), message: { kind: 'marketing', text: '  ' }, now }, hold('empty-text'));
  await check({ user: user(), message: { kind: 'marketing', text: 5 }, now }, hold('empty-text'));
  const result = await checkSend();
  assert.equal(result.allowed, false);
  assert.equal((await checkSend(null)).allowed, false);
  const hostile = { get sms() { throw new Error('boom'); }, timeZone: 'America/Chicago' };
  await check({ user: hostile, message: txn, now }, hold('internal-error'));
});
