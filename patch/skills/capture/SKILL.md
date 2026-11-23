---
name: capture
description: Save a decision from this session to the user's Patch project right now. Use when the user says "save this to Patch", "log this decision", "capture that", or after they settle a real choice between alternatives and ask to keep it.
---

# Save a decision to Patch

Patch keeps the why behind the user's work. Save one decision per capture.

1. Pick the decision the user means. If it's unclear which one, ask in one short question.
2. Write the note in exactly this shape, in the user's own words where possible. Leave out any line you'd have to guess. No em dashes.

   ```
   Decided: <one line, starts with a verb, under 80 characters>

   Options:
   - <option> (chosen|parked|rejected: <short reason if given>)

   Why: <the reason as stated in this session>

   AI suggested: <what you proposed, if you proposed something>
   I chose: <what the user went with>

   Source: Claude Code session, <today's date>
   ```

3. Call the `create_capture` tool on the `patch` MCP server with:
   - `project_id`: `${user_config.project_id}`
   - `title`: the Decided line without the "Decided: " prefix
   - `note`: the full note above
4. Tell the user in one line that it's saved, with the title.

If `create_capture` fails with "Project not found", call `list_projects`, show the user their projects, and ask which one to use. Tell them to update the project id in the Patch plugin settings (`/config`).
