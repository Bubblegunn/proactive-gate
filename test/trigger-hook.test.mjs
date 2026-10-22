import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const hooks = JSON.parse(read("hooks/hooks.json"));
const script = join(root, "hooks/trigger.sh");
const LINE = "This request is about an agent or job sending messages with limits, quiet hours, consent or legal windows: use the proactive-gate skill (Skill tool, name proactive-gate) and its library instead of hand-written rules.";

// Written here, not imported from the measurement kit, so the test does not depend on bench/.
const TRIGGERS = [
  'Add a reminder email that says "your order shipped", but never at night in their timezone.',
  "Our cron job sends push notifications to customers, so cap it at 3 per user per day.",
  "Build a nudge sender that respects quiet hours for every user.",
  "Make sure the SMS alerts honour the opt-out and STOP keywords.",
  "The digest emails should stop going out at night.",
  "Write a webhook that will text users when their order ships, with a daily limit.",
  "Our bot sends Telegram messages, so add a rate limit so nobody gets spammed.",
  "Check consent before we send any WhatsApp message to a customer.",
  "We need TCPA compliant texting hours for the collections reminders.",
  "Replay last week's notifications under a new policy and show how many would be blocked.",
  "Why did this user get no email during their snooze?",
  "Add snooze support so a user can pause the newsletter for a week.",
];

const UNRELATED = [
  "Refactor the CSV parser so it returns typed errors.",
  "Explain how B-trees keep their height balanced.",
  "Rename the variable userId to accountId across the billing module.",
  "Add a dark mode toggle to the settings page.",
  "Fix the flaky test in the checkout suite.",
  "Upgrade the TypeScript version and fix the new compiler errors.",
  "Profile the image resize worker and find the hot loop.",
  "Write a README section that explains the install steps.",
  "Why does git rebase say the branch has diverged?",
  "Set up Postgres indexes for the orders table.",
  "Show the error message from the failed build in a readable table.",
  "Limit the number of rows returned by this SQL query to 50.",
];

const runHook = (prompt, shell = "sh") =>
  spawnSync(shell, ["-u", script], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }), encoding: "utf8" });

test("hooks.json registers one UserPromptSubmit command hook that runs an executable trigger.sh", () => {
  assert.deepEqual(Object.keys(hooks.hooks), ["UserPromptSubmit"]);
  const entries = hooks.hooks.UserPromptSubmit;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hooks.length, 1);
  const [hook] = entries[0].hooks;
  assert.equal(hook.type, "command");
  assert.equal(hook.timeout, 5);
  const match = /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/trigger\.sh)"$/.exec(hook.command);
  assert.ok(match, `unexpected command: ${hook.command}`);
  const file = join(root, match[1]);
  assert.ok(existsSync(file), `${match[1]} does not exist`);
  assert.ok(statSync(file).mode & 0o111, `${match[1]} is not executable`);
});

test("the hook folder ships in the npm package", () => {
  assert.ok(pkg.files.includes("hooks"));
});

test("the hook prints exactly one context line for each trigger prompt", () => {
  for (const prompt of TRIGGERS) {
    const run = runHook(prompt);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.split("\n").filter(Boolean).length, 1, `one line for: ${prompt}`);
    assert.equal(run.stdout.trimEnd(), LINE, `the line for: ${prompt}`);
  }
});

test("the hook prints nothing and exits 0 for each unrelated prompt", () => {
  for (const prompt of UNRELATED) {
    const run = runHook(prompt);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "", `silence for: ${prompt}`);
  }
});

test("the hook also runs under dash with nounset", (t) => {
  if (spawnSync("dash", ["-c", "exit 0"]).status !== 0) return t.skip("dash is not installed");
  for (const prompt of [TRIGGERS[0], UNRELATED[0]]) {
    const run = runHook(prompt, "dash");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trimEnd(), prompt === TRIGGERS[0] ? LINE : "");
  }
});

test("the hook is POSIX sh with no network, no file writes and no JSON or language runtime", () => {
  const source = read("hooks/trigger.sh");
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(source, /\b(curl|wget|jq|python3?|node|nc|ssh|bash)\b/, "no network tool, JSON parser or language runtime");
  assert.doesNotMatch(source, />/, "no redirection to a file");
  assert.doesNotMatch(source, /\[\[ /, "no bash [[ test syntax");
});
