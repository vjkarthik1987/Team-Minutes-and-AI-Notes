# v25.4 — Thread links, clean insights, and person briefings

## Thread detail
- Human insight textarea now starts blank on load.
- Added Links & Dashboards section for JIRA, Confluence, Power BI, GitHub and other URLs.
- Links can be added from the thread page and are shown on the right side.
- Active/status and health score are shown as cleaner pills.
- Latest insight display is cleaned to remove internal template leakage such as Executive Memory / Outcome Objective / Evidence Base.

## Home
- Thread cards have a light grey border.
- Thread cards show useful link count and top links.
- Thread insight text is cleaned before rendering.
- Added For Your Attention briefings section.

## Briefings
- New person-to-person briefing model.
- Users can send a note/letter to another user.
- Briefings can reference one or more threads.
- Briefings support attachments.
- Briefings remain visible on recipient Home page until dismissed/ended.

## Data model
- Added Briefing model.
- Added usefulLinks to MeetingThread.
