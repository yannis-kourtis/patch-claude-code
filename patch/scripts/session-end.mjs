#!/usr/bin/env node
// Patch auto-capture: SessionEnd hook for Claude Code.
//
// When a Claude Code session ends, read its transcript, ask a headless
// `claude -p` run for the 0 to 3 real decisions in it, and save each one as a
// capture in the user's Patch project through the existing create-capture
// REST endpoint (same contract as the MCP create_capture tool, see
// docs/mcp-capture-endpoint-plan.md). Runs as an async hook, so it never
// delays the session closing.
//
// Never throws to Claude Code: every failure is logged to
// $CLAUDE_PLUGIN_DATA/autocapture.log and the process exits 0.
//
// Manual test:
//   node session-end.mjs --transcript path/to/session.jsonl --dry-run

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "..", "prompts", "extract-decisions.md");

/** Set on the child `claude -p` run so its own SessionEnd hook does nothing. */
export const CHILD_ENV_FLAG = "PATCH_AUTOCAPTURE_CHILD";

const MAX_DECISIONS = 3;
const MAX_TRANSCRIPT_CHARS = 60_000;
const HEAD_CHARS = 6_000;
const MAX_TITLE = 80;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const PROCESSED_KEEP = 500;

// ---------- config ----------

export function readConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === "" ? d : !/^(false|0|no|off)$/i.test(String(v)));
  return {
    token: env.CLAUDE_PLUGIN_OPTION_PATCH_TOKEN ?? env.PATCH_TOKEN ?? "",
    projectId: env.CLAUDE_PLUGIN_OPTION_PROJECT_ID ?? env.PATCH_PROJECT_ID ?? "",
    autoCapture: bool(env.CLAUDE_PLUGIN_OPTION_AUTO_CAPTURE, true),
    minUserTurns: num(env.CLAUDE_PLUGIN_OPTION_MIN_USER_TURNS, 4),
    apiBaseUrl: (env.CLAUDE_PLUGIN_OPTION_API_BASE_URL || "https://vkjdwdadejhyngswzprc.supabase.co").replace(/\/+$/, ""),
    model: env.PATCH_AUTOCAPTURE_MODEL || "sonnet",
    dataDir: env.CLAUDE_PLUGIN_DATA || join(HERE, "..", ".data"),
    dryRun: bool(env.PATCH_AUTOCAPTURE_DRY_RUN, false),
  };
}

// ---------- transcript ----------

const NOISE_RE = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

function cleanText(text) {
  return String(text ?? "").replace(NOISE_RE, "").trim();
}

/**
 * Turn a Claude Code JSONL transcript into a compact readable dialogue.
 * Keeps what the person said and what the agent said; tool calls become one
 * short line; tool results, subagent (sidechain) and meta records are dropped.
 */
export function parseTranscript(jsonl) {
  const turns = [];
  let userTurns = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (rec.isSidechain || rec.isMeta) continue;
    const content = rec.message?.content;
    const parts = [];
    if (typeof content === "string") {
      parts.push(cleanText(content));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") parts.push(cleanText(block.text));
        else if (block?.type === "tool_use" && rec.type === "assistant") parts.push(`[used ${block.name}]`);
        // tool_result, thinking, images: skipped on purpose
      }
    }
    const text = parts.filter(Boolean).join("\n").trim();
    if (!text) continue;
    if (rec.type === "user") userTurns += 1;
    turns.push({ role: rec.type === "user" ? "Person" : "Agent", text });
  }
  return { turns, userTurns };
}

/** Dialogue text, capped: keeps the opening (the goal) and the most recent part. */
export function renderDialogue(turns, maxChars = MAX_TRANSCRIPT_CHARS) {
  const full = turns.map((t) => `${t.role}: ${t.text}`).join("\n\n");
  if (full.length <= maxChars) return full;
  const head = full.slice(0, HEAD_CHARS);
  const tail = full.slice(full.length - (maxChars - HEAD_CHARS));
  return `${head}\n\n[... middle of the session omitted ...]\n\n${tail}`;
}

// ---------- extraction ----------

/** Pull the JSON object out of a model reply, tolerating fences or stray prose. */
export function parseDecisions(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(obj?.decisions) ? obj.decisions : [];
  return list
    .filter((d) => d && typeof d.decision === "string" && d.decision.trim())
    .slice(0, MAX_DECISIONS)
    .map((d) => ({
      decision: d.decision.trim(),
      options: Array.isArray(d.options)
        ? d.options
            .filter((o) => o && typeof o.option === "string" && o.option.trim())
            .map((o) => ({
              option: o.option.trim(),
              outcome: ["chosen", "parked", "rejected"].includes(o.outcome) ? o.outcome : "rejected",
              reason: typeof o.reason === "string" ? o.reason.trim() : "",
            }))
        : [],
      why: typeof d.why === "string" ? d.why.trim() : "",
      ai_suggested: typeof d.ai_suggested === "string" ? d.ai_suggested.trim() : "",
      person_chose: typeof d.person_chose === "string" ? d.person_chose.trim() : "",
    }));
}

function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--model", model], {
      env: { ...process.env, [CHILD_ENV_FLAG]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("claude -p timed out"));
    }, EXTRACT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${(err || out).slice(0, 300)}`));
      try {
        const parsed = JSON.parse(out);
        resolve(typeof parsed.result === "string" ? parsed.result : out);
      } catch {
        resolve(out);
      }
    });
    child.stdin.end(prompt);
  });
}

export function buildPrompt(dialogue, instructions) {
  return `${instructions.trim()}\n\n<session>\n${dialogue}\n</session>\n`;
}

// ---------- capture ----------

/**
 * The capture note. First line doubles as the derived title in the app and
 * contains "Decided" so the keyword rules in captureDerivation.ts file it as
 * a decision.
 */
export function formatCapture(d, meta) {
  const title = d.decision.length > MAX_TITLE ? `${d.decision.slice(0, MAX_TITLE - 1).trimEnd()}…` : d.decision;
  const lines = [`Decided: ${d.decision}`];
  if (d.options.length) {
    lines.push("", "Options:");
    for (const o of d.options) lines.push(`- ${o.option} (${o.outcome}${o.reason ? `: ${o.reason}` : ""})`);
  }
  if (d.why) lines.push("", `Why: ${d.why}`);
  if (d.ai_suggested) lines.push("", `AI suggested: ${d.ai_suggested}`);
  if (d.person_chose) lines.push(`I chose: ${d.person_chose}`);
  lines.push("", `Source: Claude Code session ${meta.sessionShort}${meta.repo ? ` in ${meta.repo}` : ""}, ${meta.date}`);
  return { title, note: lines.join("\n") };
}

async function postCapture(cfg, payload) {
  const res = await fetch(`${cfg.apiBaseUrl}/functions/v1/create-capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: cfg.projectId, title: payload.title, note: payload.note }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`create-capture ${res.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

// ---------- bookkeeping ----------

function logLine(cfg, message) {
  if (cfg.dryRun) process.stderr.write(`${message}\n`);
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    appendFileSync(join(cfg.dataDir, "autocapture.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never fail the hook
  }
}

function loadProcessed(cfg) {
  const file = join(cfg.dataDir, "processed.json");
  try {
    return { file, ids: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { file, ids: [] };
  }
}

function saveProcessed(cfg, state, id) {
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    const ids = [...state.ids.filter((x) => x !== id), id].slice(-PROCESSED_KEEP);
    writeFileSync(state.file, JSON.stringify(ids));
  } catch {
    // best effort
  }
}

// ---------- main ----------

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parseArgs(argv) {
  const args = { transcript: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--transcript") args.transcript = argv[++i] ?? "";
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

export async function main({ argv = process.argv.slice(2), env = process.env, extract = runClaude, post = postCapture, stdinText } = {}) {
  if (env[CHILD_ENV_FLAG]) return { skipped: "child run" };

  const args = parseArgs(argv);
  const cfg = readConfig(env);
  if (args.dryRun) cfg.dryRun = true;

  let input = {};
  const raw = stdinText ?? (args.transcript ? "" : await readStdin());
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      logLine(cfg, "skip: hook input was not JSON");
      return { skipped: "bad input" };
    }
  }
  const transcriptPath = args.transcript || input.transcript_path;
  const sessionId = input.session_id || basename(transcriptPath || "manual", ".jsonl");

  if (!cfg.autoCapture && !cfg.dryRun) return { skipped: "auto_capture off" };
  if (!cfg.dryRun && (!cfg.token || !cfg.projectId)) {
    logLine(cfg, "skip: set patch_token and project_id in the plugin settings");
    return { skipped: "not configured" };
  }
  if (!transcriptPath || !existsSync(transcriptPath)) {
    logLine(cfg, `skip: no transcript for ${sessionId}`);
    return { skipped: "no transcript" };
  }

  const processed = loadProcessed(cfg);
  if (!cfg.dryRun && processed.ids.includes(sessionId)) return { skipped: "already processed" };

  const { turns, userTurns } = parseTranscript(readFileSync(transcriptPath, "utf8"));
  if (userTurns < cfg.minUserTurns) {
    logLine(cfg, `skip: ${sessionId} has ${userTurns} messages from you (min ${cfg.minUserTurns})`);
    return { skipped: "too short" };
  }

  const prompt = buildPrompt(renderDialogue(turns), readFileSync(PROMPT_PATH, "utf8"));
  let decisions;
  try {
    decisions = parseDecisions(await extract(prompt, cfg.model));
  } catch (e) {
    logLine(cfg, `error: extraction failed for ${sessionId}: ${e.message}`);
    return { error: e.message };
  }

  const meta = {
    sessionShort: String(sessionId).slice(0, 8),
    repo: input.cwd ? basename(input.cwd) : "",
    date: new Date().toISOString().slice(0, 10),
  };
  const captures = decisions.map((d) => formatCapture(d, meta));

  if (cfg.dryRun) {
    if (!captures.length) process.stdout.write(`0 decisions found in ${userTurns} messages from you. Nothing would be saved.\n`);
    else process.stdout.write(`${captures.length} decision(s) found\n\n${captures.map((c) => c.note).join("\n\n---\n\n")}\n`);
    return { dryRun: true, captures };
  }

  let saved = 0;
  for (const c of captures) {
    try {
      await post(cfg, c);
      saved += 1;
    } catch (e) {
      logLine(cfg, `error: ${sessionId}: ${e.message}`);
    }
  }
  // Retry next time if nothing could be saved (e.g. offline); otherwise never twice.
  if (saved > 0 || captures.length === 0) saveProcessed(cfg, processed, sessionId);
  logLine(cfg, `ok: ${sessionId}: ${decisions.length} decision(s), ${saved} saved`);
  return { saved, captures };
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const DETACHED_FLAG = "PATCH_AUTOCAPTURE_DETACHED";
const INPUT_ENV = "PATCH_AUTOCAPTURE_INPUT";

if (isEntry) {
  const args = process.argv.slice(2);
  if (process.env[CHILD_ENV_FLAG]) {
    process.exit(0);
  } else if (!process.env[DETACHED_FLAG] && !args.includes("--transcript")) {
    // Called as the SessionEnd hook: hand the work to a detached copy of this
    // script and return at once, so extraction survives Claude Code exiting.
    readStdin()
      .then((stdinText) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, [DETACHED_FLAG]: "1", [INPUT_ENV]: stdinText },
        });
        child.unref();
      })
      .catch((e) => logLine(readConfig(), `error: could not start: ${e?.message ?? e}`))
      .finally(() => process.exit(0));
  } else {
    main({ stdinText: process.env[INPUT_ENV] })
      .catch((e) => logLine(readConfig(), `error: ${e?.message ?? e}`))
      .finally(() => process.exit(0));
  }
}
