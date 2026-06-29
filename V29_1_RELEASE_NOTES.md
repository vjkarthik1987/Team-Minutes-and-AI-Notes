# Ms. Minutes v29.1

Small fixes after v29 feedback:

- Fixed dark date tiles so the day number is visible.
- Kept Intelligence and thread quick-answer loading inside the popup instead of blocking the whole page with the global animation.
- Fixed missing generated-time metadata rendering in thread quick intelligence.
- Made Outlook refresh faster for upcoming/future meetings by skipping saved-transcript fuzzy matching until the meeting has ended.
- Prevented future/live duplicated meetings from inheriting transcript-ready flags during refresh.
- Styled the `.ics` import picker on Meetings, Intelligence, and Thread detail pages.
- Removed owner labels from AI-visible meeting summaries and meeting/intelligence answers. Actions now focus on the work and due/timing rather than `[Owner: Unassigned]`.

Validation:

```powershell
node --check routes/user.js
node --check utils/openaiSummary.js
node --check server.js
```

EJS views were compile-checked.
