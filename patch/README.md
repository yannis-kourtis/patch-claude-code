# Patch for Claude Code

Saves the decisions you make in Claude Code to your Patch project, so you never have to reconstruct the why later.

- **Automatic:** when a session ends, Patch reads it in the background and saves the 0 to 3 real decisions it finds: what you decided, the options, why, what the AI suggested and what you chose.
- **On demand:** say "save this to Patch" mid-session, or run `/patch:capture`.
- **Patch MCP tools** (`list_projects`, `create_capture`) are available in every session.

v0: decisions are saved straight into the project as captures. An approve-or-dismiss Inbox comes in v1.

## Install

From a local clone of this repo, inside Claude Code:

```
/plugin marketplace add /path/to/patchwork-portfolio/integrations/claude-code
/plugin install patch@patch
```

Claude Code then asks for:

| Setting | What to enter |
| --- | --- |
| Patch access token | A `patch_pat_…` token from Patch: sidebar > Access tokens (app.getpatchapp.com/access-tokens) |
| Patch project id | The project decisions go to. Ask Claude "list my Patch projects" to find it |
| Save decisions when a session ends | On by default |
| Shortest session to read | Sessions with fewer of your messages are skipped (default 4) |

Change any of them later in `/config`.

## How auto-capture works

1. The `SessionEnd` hook starts `scripts/session-end.mjs` and returns at once, so closing a session is never slowed down.
2. The script reads the session transcript and keeps only what you and the agent said. Tool output, subagents and system text are dropped, and very long sessions keep their start and end.
3. It runs `claude -p` with `prompts/extract-decisions.md` on your own Claude Code login. No extra API key is needed. The child run is flagged so it never triggers the hook again.
4. Each decision is posted to Patch's `create-capture` endpoint with your token. A session is never saved twice. If saving fails (for example, offline), it's retried the next time that session ends.

Logs: `~/.claude/plugins/data/patch-*/autocapture.log`.

## Try it without saving

```
node scripts/session-end.mjs --transcript ~/.claude/projects/<project>/<session>.jsonl --dry-run
```

This prints the decisions it would save. Set `PATCH_AUTOCAPTURE_MODEL` to try another model (default `sonnet`).

## Tests

```
node --test integrations/claude-code/patch/scripts/session-end.test.mjs
```

## Known limits (v0)

- Capture type is still inferred from keywords in the note, so a decision whose note mentions a percentage is filed as a result. v1 sends an explicit type.
- No Inbox yet: every extracted decision lands in the project. Delete the ones you don't want in Patch.
- Only Claude Code sessions are read. Other agents come later.
