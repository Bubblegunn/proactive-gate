// Worker process for the H4 checker (deliver). Not run by hand.
// usage: node worker4.mjs <botdir> <stateDir> <logFile> <jsonPlan> [crashEventId]
// jsonPlan is a list of {user, eventId, now}. Entries run together (Promise.all) unless env SEQ=1,
// in which case they run one after another in list order.
// Every deliver call gets its own send(): it appends "userId|eventId" to logFile synchronously, awaits a
// 5 ms timer, and when eventId equals crashEventId it sends SIGKILL to this process before resolving.
// Prints RESULT<json array of deliver results, in plan order> on stdout. A killed process prints nothing.
import { appendFileSync } from "node:fs";
import { load } from "./lib.mjs";

const [dir, stateDir, logFile, planJson, crashEventId] = process.argv.slice(2);
process.env.STATE_DIR = stateDir;

const makeSend = (userId, eventId) => async () => {
  appendFileSync(logFile, `${userId}|${eventId}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (crashEventId !== undefined && eventId === crashEventId) process.kill(process.pid, "SIGKILL");
};

const bot = await load(dir);
const plan = JSON.parse(planJson);

const one = async (entry) => {
  try {
    return await bot.deliver({
      user: entry.user,
      eventId: entry.eventId,
      now: new Date(entry.now),
      send: makeSend(entry.user.id, entry.eventId),
    });
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
};

let out;
if (process.env.SEQ === "1") {
  out = [];
  for (const entry of plan) out.push(await one(entry));
} else {
  out = await Promise.all(plan.map(one));
}
process.stdout.write("RESULT" + JSON.stringify(out) + "\n");
