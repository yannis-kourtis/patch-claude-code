// Run with: node --test integrations/claude-code/patch/scripts/
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CHILD_ENV_FLAG,
  formatCapture,
  main,
  parseDecisions,
  parseTranscript,
  renderDialogue,
} from "./session-end.mjs";

const rec = (o) => JSON.stringify(o);
const TRANSCRIPT = [
  rec({ type: "summary", summary: "x" }),
  rec({ type: "user", message: { role: "user", content: "Let's redesign the vehicle upgrade step" } }),
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I suggest a modal with three cards." }, { type: "tool_use", name: "Edit", input: {} }] } }),
  rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "huge file dump" }] } }),
  rec({ type: "user", message: { role: "user", content: "No, a bottom sheet. Modals block the price summary.<system-reminder>ignore me</system-reminder>" } }),
  rec({ type: "user", isSidechain: true, message: { role: "user", content: "subagent chatter" } }),
  rec({ type: "user", isMeta: true, message: { role: "user", content: "meta" } }),
  rec({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done, bottom sheet it is." }] } }),
  "not json",
].join("\n");

test("parseTranscript keeps dialogue and drops tool results, sidechains, meta and reminders", () => {
  const { turns, userTurns } = parseTranscript(TRANSCRIPT);
  assert.equal(userTurns, 2);
  const text = renderDialogue(turns);
  assert.match(text, /Person: Let's redesign/);
  assert.match(text, /\[used Edit\]/);
  assert.doesNotMatch(text, /huge file dump|subagent chatter|ignore me|meta/);
});

test("renderDialogue keeps the start and the end when too long", () => {
  const turns = Array.from({ length: 400 }, (_, i) => ({ role: "Person", text: `message ${i} ${"x".repeat(300)}` }));
  const out = renderDialogue(turns, 20_000);
  assert.ok(out.length <= 20_100);
  assert.match(out, /message 0 /);
  assert.match(out, /message 399 /);
  assert.match(out, /omitted/);
});

test("parseDecisions tolerates fences, caps at 3 and cleans fields", () => {
  const reply = "Here you go:\n```json\n" + JSON.stringify({
    decisions: [
      { decision: "Use a bottom sheet", options: [{ option: "Modal", outcome: "weird", reason: "blocks price" }, { option: "Bottom sheet", outcome: "chosen" }], why: "Keeps price visible" },
      { decision: "  " },
      { decision: "B" }, { decision: "C" }, { decision: "D" },
    ],
  }) + "\n```";
  const ds = parseDecisions(reply);
  assert.equal(ds.length, 3);
  assert.equal(ds[0].options[0].outcome, "rejected");
  assert.equal(ds[0].ai_suggested, "");
  assert.deepEqual(parseDecisions("no json here"), []);
  assert.deepEqual(parseDecisions('{"decisions": []}'), []);
});

test("formatCapture writes a decision-typed note with a short title", () => {
  const { title, note } = formatCapture(
    { decision: "Use a bottom sheet for upgrades", options: [{ option: "Modal", outcome: "rejected", reason: "blocks price" }], why: "Price stays visible", ai_suggested: "A modal", person_chose: "A bottom sheet" },
    { sessionShort: "abcd1234", repo: "patchwork", date: "2026-11-23" },
  );
  assert.equal(title, "Use a bottom sheet for upgrades");
  assert.match(note, /^Decided: /);
  assert.match(note, /- Modal \(rejected: blocks price\)/);
  assert.match(note, /AI suggested: A modal\nI chose: A bottom sheet/);
  assert.match(note, /Source: Claude Code session abcd1234 in patchwork, 2026-11-23/);
  assert.equal(formatCapture({ decision: "x".repeat(120), options: [], why: "", ai_suggested: "", person_chose: "" }, { sessionShort: "", repo: "", date: "" }).title.length, 80);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "patch-ac-"));
  const transcript = join(dir, "s1.jsonl");
  writeFileSync(transcript, TRANSCRIPT);
  const env = {
    CLAUDE_PLUGIN_OPTION_PATCH_TOKEN: "patch_pat_test",
    CLAUDE_PLUGIN_OPTION_PROJECT_ID: "00000000-0000-0000-0000-000000000000",
    CLAUDE_PLUGIN_OPTION_MIN_USER_TURNS: "2",
    CLAUDE_PLUGIN_DATA: join(dir, "data"),
  };
  const stdinText = JSON.stringify({ session_id: "sess-1", transcript_path: transcript, cwd: "/x/patchwork" });
  return { env, stdinText };
}

const EXTRACT = async () => JSON.stringify({ decisions: [{ decision: "Use a bottom sheet", options: [], why: "Price stays visible" }] });

test("main posts each decision once per session", async () => {
  const { env, stdinText } = setup();
  const posted = [];
  const post = async (cfg, c) => posted.push({ cfg, c });
  const r1 = await main({ argv: [], env, stdinText, extract: EXTRACT, post });
  assert.equal(r1.saved, 1);
  assert.equal(posted[0].cfg.projectId, "00000000-0000-0000-0000-000000000000");
  assert.match(posted[0].c.note, /Source: Claude Code session sess-1 in patchwork/);
  const r2 = await main({ argv: [], env, stdinText, extract: EXTRACT, post });
  assert.equal(r2.skipped, "already processed");
  assert.equal(posted.length, 1);
});

test("main skips child runs, short sessions, missing config and disabled capture", async () => {
  const { env, stdinText } = setup();
  const never = async () => assert.fail("should not extract");
  assert.equal((await main({ env: { ...env, [CHILD_ENV_FLAG]: "1" }, stdinText, extract: never })).skipped, "child run");
  assert.equal((await main({ argv: [], env: { ...env, CLAUDE_PLUGIN_OPTION_MIN_USER_TURNS: "5" }, stdinText, extract: never })).skipped, "too short");
  assert.equal((await main({ argv: [], env: { ...env, CLAUDE_PLUGIN_OPTION_PATCH_TOKEN: "" }, stdinText, extract: never })).skipped, "not configured");
  assert.equal((await main({ argv: [], env: { ...env, CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE: "false" }, stdinText, extract: never })).skipped, "auto_capture off");
});

test("main survives a failed extraction and a failed post", async () => {
  const { env, stdinText } = setup();
  const r = await main({ argv: [], env, stdinText, extract: async () => { throw new Error("boom"); } });
  assert.equal(r.error, "boom");
  const r2 = await main({ argv: [], env: { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA + "2" }, stdinText, extract: EXTRACT, post: async () => { throw new Error("500"); } });
  assert.equal(r2.saved, 0);
  const posted = [];
  const r3 = await main({ argv: [], env: { ...env, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA + "2" }, stdinText, extract: EXTRACT, post: async (_c, c) => posted.push(c) });
  assert.equal(r3.saved, 1, "a failed save is retried next time");
});
