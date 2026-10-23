// Worker process for the X1 and X2 checkers. Not run by hand.
// usage: node worker5.mjs <botdir> <stateDir> <logFile> <jsonPlan>   (env CONC=1 runs the plan concurrently)
// jsonPlan is a list of items, each {fn, ...}:
//   fn "notify":       {user, notification, now, failChannels?} calls bot.notify. Its deliver(channel) appends
//                      "userId|notificationId|channel" to logFile on every call (an attempt), waits 5 ms, then throws
//                      when channel is in failChannels.
//   fn "guardedSend":  {agentId, user, message, now} calls bot.guardedSend. Its send() appends "userId|messageId"
//                      to logFile.
//   fn "verifyAudit":  calls bot.verifyAudit() with no arguments (reads STATE_DIR from the environment).
// Items run one after another in list order unless CONC=1 (then Promise.all). An item that throws yields {error}.
// Prints RESULT<json array of item results, in plan order>. A process that cannot load the bot prints nothing.
import { appendFileSync } from "node:fs";
import { load } from "./lib.mjs";

const [dir, stateDir, logFile, planJson] = process.argv.slice(2);
process.env.STATE_DIR = stateDir;
const bot = await load(dir);
const plan = JSON.parse(planJson);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const one = async (item) => {
  try {
    if (item.fn === "notify") {
      const deliver = async (channel) => {
        appendFileSync(logFile, `${item.user.id}|${item.notification.id}|${channel}\n`);
        await sleep(5);
        if ((item.failChannels ?? []).includes(channel)) throw new Error(`${channel} is down`);
      };
      return await bot.notify({
        user: item.user,
        notification: item.notification,
        now: new Date(item.now),
        deliver,
      });
    }
    if (item.fn === "guardedSend") {
      const send = async () => {
        appendFileSync(logFile, `${item.user.id}|${item.message.id}\n`);
      };
      return await bot.guardedSend({
        agentId: item.agentId,
        user: item.user,
        message: item.message,
        now: new Date(item.now),
        send,
      });
    }
    if (item.fn === "verifyAudit") return await bot.verifyAudit();
    return { error: `unknown fn ${item.fn}` };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
};

let out;
if (process.env.CONC === "1") out = await Promise.all(plan.map(one));
else {
  out = [];
  for (const item of plan) out.push(await one(item));
}
process.stdout.write("RESULT" + JSON.stringify(out) + "\n");
