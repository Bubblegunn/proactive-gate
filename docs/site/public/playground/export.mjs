/**
 * Taking the run with you: the policy as a file, the command that replays it, and the lines
 * that wire it into a real program.
 *
 * Everything here is a pure function of the policy and the input you just ran, so what the
 * page offers is the run in front of you rather than a generic sample. test/snippet.test.mjs
 * generates these exact strings and executes them against the built package, so the snippet on
 * the page is a snippet that runs.
 *
 * What this deliberately is not: a share link. No URL fragment, no query string, no share card
 * and no upload. A shareable link for this page needs a versioned-config design first, and
 * until that exists the safe thing is to put nothing in a URL: the input box can hold a user
 * id, a payload, event text, a token or someone's real quiet hours, and a URL is copied into
 * chat logs, pasted into issues and kept in browser history. A file the reader saves themselves
 * has none of those problems.
 */

export const PACKAGE = "proactive-gate";
export const POLICY_FILE = "proactive-gate.policy.json";
export const EVENTS_FILE = "day.jsonl";

/** Install the package. Zero runtime dependencies, so this is the whole of it. */
export const installCommand = `npm install ${PACKAGE}`;

/**
 * Replay a file of candidates through the policy, consuming budgets in order as production
 * would. The CLI ships in the package, so npx runs the version you just installed.
 */
export const replayCommand = `npx ${PACKAGE} replay ${EVENTS_FILE} --policy ${POLICY_FILE} --commit`;

/** The policy as the file the CLI and the snippet both read. */
export function policyFileText(policy) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/**
 * The run as a one-line JSONL file for the CLI.
 *
 * `deliveredToday` is dropped on the way out. It is the playground's own key for spending the
 * budget before the shown decision, and the library does not read it, so writing it into a file
 * that looks like a library input would be handing over one field that silently does nothing.
 */
export function eventsFileText(input) {
  const { user, candidate, now } = input;
  return `${JSON.stringify({ user, candidate, ...(now ? { now } : {}) })}\n`;
}

const indent = (text, spaces) => text.split("\n").join(`\n${" ".repeat(spaces)}`);

/**
 * The lines that put this decision in front of a real send.
 *
 * It is written to run as it stands: `node run.mjs` beside the policy file does a real
 * evaluate, a real commit and prints what the gate said. The only thing standing in for your
 * product is the send itself, which is a console.log rather than a push service, because a demo
 * that asked for a key would not be a demo.
 *
 * The shape is the one that matters and the reason this is worth copying: evaluate, then commit,
 * and only send when commit returned true. commit is the atomic increment that takes the budget
 * unit, and it can still refuse when a concurrent delivery took the last one.
 */
export function wireUpSnippet(input) {
  const user = indent(JSON.stringify(input.user, null, 2), 0);
  const candidate = indent(JSON.stringify(input.candidate, null, 2), 0);
  const now = input.now ? `\n// The instant this scenario runs at. Drop it to use the real clock.\nconst now = new Date("${input.now}");\n` : "\nconst now = undefined;\n";
  return `import { readFileSync } from "node:fs";
import { createGate, MemoryStore, explain } from "${PACKAGE}";

// The policy you just edited, saved as ${POLICY_FILE}.
const policy = JSON.parse(readFileSync("${POLICY_FILE}", "utf8"));

// MemoryStore is one process. Use RedisStore(client) or SqliteStore once you run more than one,
// or two instances will each keep their own idea of the user's budget.
const gate = createGate({ policy, store: new MemoryStore() });

const user = ${user};

const candidate = ${candidate};
${now}
const input = { user, candidate, now };
const decision = await gate.evaluate(input);

// evaluate says it may go; commit takes the budget unit and can still refuse when another
// delivery took the last one. Send only when commit returned true.
if (decision.allowed && (await gate.commit(decision, input))) {
  console.log("send", decision.surfaces.join(","));
} else {
  console.log("stopped", explain(decision).sentence);
}
`;
}

/** Everything the page can hand over, for one run. */
export function exportBundle(policy, input) {
  return {
    install: installCommand,
    replay: replayCommand,
    policyFile: { name: POLICY_FILE, text: policyFileText(policy) },
    eventsFile: { name: EVENTS_FILE, text: eventsFileText(input) },
    snippet: { name: "run.mjs", text: wireUpSnippet(input) },
  };
}
