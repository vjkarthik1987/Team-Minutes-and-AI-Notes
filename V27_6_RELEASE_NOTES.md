# v27.6 — Better Teams-style summaries + basic Threads

## Summary generation
- Strengthened the 3-pass summary pipeline while keeping the existing OpenAI/gpt-4o-mini path.
- Pass 1 now over-extracts themes, subtopics, action candidates, risks, decisions, and speaker/owner clues from each chunk.
- Pass 2 now builds a complete meeting map and explicitly preserves all unique follow-up tasks.
- Pass 3 now forces a Microsoft Teams-style output and blocks the older thin sections such as Intelligent Summary, Key Outcomes, and Executive Readout.
- Speaker attribution rules were tightened for Teams transcripts where multiple people may appear under one signed-in user label.

## Threads
- Added a simplified `/user/threads` page instead of the old placeholder.
- Added thread cards with status, objective, owner, linked meeting count, open actions, and risks.
- Added basic thread creation.
- Added a simple thread detail page with linked meetings and recent thread context.
- Added a simple note/decision/risk/action/status entry form.

## UI
- Kept the simplified Ms. Minutes header and logout across the new thread pages.
- Added compact responsive thread cards and detail panels.
