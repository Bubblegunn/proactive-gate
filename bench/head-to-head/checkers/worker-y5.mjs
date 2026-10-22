// Worker process for the Y5 checker (createSender). Not run by hand.
// usage: node worker-y5.mjs <botdir> <jsonPlan>
// jsonPlan = { config, calls: [{ user, now }], conc }. It builds one sender from config, then runs trySend for each call
// (all at once when conc is true, otherwise one after another in list order). Prints RESULT<json array> on stdout.
// A config that makes createSender throw gives one {error} entry per call.
import { load } from "./lib.mjs";

const [dir, planJson] = process.argv.slice(2);
const plan = JSON.parse(planJson);
const errText = (e) => String((e && e.message) || e).slice(0, 200);

let out;
try {
  const bot = await load(dir);
  let sender;
  try {
    sender = await Promise.resolve().then(() => bot.createSender(plan.config));
  } catch (e) {
    out = plan.calls.map(() => ({ error: errText(e) }));
  }
  if (sender) {
    const one = async (c) => {
      try {
        return await sender.trySend({ user: c.user, now: new Date(c.now) });
      } catch (e) {
        return { error: errText(e) };
      }
    };
    if (plan.conc) out = await Promise.all(plan.calls.map(one));
    else {
      out = [];
      for (const c of plan.calls) out.push(await one(c));
    }
  }
} catch (e) {
  out = [{ error: errText(e) }];
}
process.stdout.write("RESULT" + JSON.stringify(out) + "\n");
