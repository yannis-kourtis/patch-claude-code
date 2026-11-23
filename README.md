# Patch for Claude Code

Patch keeps the why behind your work. This plugin saves the decisions you make in Claude Code to your [Patch](https://getpatchapp.com) project, while you work. You don't type anything.

When a session ends, Patch reads it and saves the 0 to 3 real product or design decisions in it: what you decided, the options, why, and what Claude suggested versus what you chose.

## Install

In Claude Code:

```
/plugin marketplace add yannis-kourtis/patch-claude-code
/plugin install patch@patch
```

Claude Code then asks for two things:

1. **Patch access token.** In Patch, open **Access tokens** in the sidebar ([app.getpatchapp.com/access-tokens](https://app.getpatchapp.com/access-tokens)) and generate one. It starts with `patch_pat_`.
2. **Patch project id.** Open the project in Patch and copy the code after `/project/` in the address bar.

Restart Claude Code. That's it.

## Save a decision now

Say "save this to Patch" in any session, or run `/patch:capture`.

## Privacy

Session text is read on your own machine by your own Claude Code login. Only the extracted decisions are sent to Patch. Turn auto-capture off any time in `/config`.

More detail, dry runs and tests: [patch/README.md](patch/README.md).
