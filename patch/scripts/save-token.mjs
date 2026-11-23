#!/usr/bin/env node
// SessionStart hook: copy the Patch token from the plugin's secure settings
// (exported to hooks as CLAUDE_PLUGIN_OPTION_PATCH_TOKEN) into a private file
// in the plugin data dir, where mcp-headers.mjs reads it for the MCP server.
// Logs only the token's length and prefix, never the token.
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const token = (process.env.CLAUDE_PLUGIN_OPTION_PATCH_TOKEN || "").trim();
const dataDir = process.env.CLAUDE_PLUGIN_DATA;
try {
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    const ok = token.startsWith("patch_pat_");
    if (ok) {
      const file = join(dataDir, "token");
      writeFileSync(file, token, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    appendFileSync(
      join(dataDir, "autocapture.log"),
      `${new Date().toISOString()} token: ${token ? `${token.length} chars, ${ok ? "starts with patch_pat_" : "does NOT start with patch_pat_"}` : "not set"}\n`,
    );
  }
} catch {
  // never block a session from starting
}
process.exit(0);
