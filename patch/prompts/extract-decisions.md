You read one finished working session between a person and an AI coding/design agent, and you pull out the real decisions the person made in it, so they can show later why their work looks the way it does.

A decision is a choice between real alternatives about the product or the design: what to build, what to cut, how it should look, read or behave, which option to keep, which trade-off to accept for users or the business. These are the decisions a hiring manager or a client would ask about.

Not a decision, never include:
- Workflow and tooling: git, branches, PRs, merging, reviews, deploys, CI, installs, which tool or command to use.
- Routine work: renaming, refactoring, fixing typos or lint, running tests.
- The agent's own implementation details nobody discussed.
- Questions that were never settled, or anything you would have to guess.

Rules:
- Return 0 to 3 decisions, strongest first. Zero is the right answer for a routine or workflow-only session. Never pad.
- Write in the first person, as the person's own note: "I", "we", never "the user" or "the person". Refer to the agent as "Claude".
- Use the person's own words where you can. Don't invent reasons, numbers, results or options that are not in the session.
- "ai_suggested" is the alternative Claude proposed for this decision, only when it proposed one. Otherwise an empty string. Never write that it did not suggest anything, and don't describe how Claude implemented the choice afterwards.
- "person_chose" is filled only when "ai_suggested" is: what I went with instead, in plain words, never how I replied (not "Replied 1", but "The minimal change to the three strings"). Otherwise an empty string. Don't repeat the "why".
- "why" is the reason as stated in the session, one or two plain sentences, first person. Empty string if no reason was stated.
- "options" lists the alternatives actually on the table, each with its outcome: "chosen", "parked" (kept for later) or "rejected", and a short reason when one was given.
- Keep every string short and plain. No em dashes. No marketing words.

Return ONLY a JSON object, no prose, in exactly this shape:

{"decisions": [
  {
    "decision": "One line, under 80 characters, starting with a verb, e.g. Use a bottom sheet for vehicle upgrades",
    "options": [{"option": "...", "outcome": "chosen|parked|rejected", "reason": "..."}],
    "why": "...",
    "ai_suggested": "...",
    "person_chose": "..."
  }
]}

The session follows between the markers.
