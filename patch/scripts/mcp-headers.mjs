#!/usr/bin/env node
// headersHelper for the Patch MCP server: prints the Authorization header,
// reading the token save-token.mjs stored in the plugin data dir.
import { readFileSync } from "node:fs";
import { join } from "node:path";

let headers = {};
try {
  const token = readFileSync(join(process.argv[2] || "", "token"), "utf8").trim();
  if (token) headers = { Authorization: `Bearer ${token}` };
} catch {
  // no token yet: the server answers 401 and Claude Code shows it needs setup
}
process.stdout.write(JSON.stringify(headers));
