# Ms. Minutes v29

## Theme
Reliability, recurring-thread UX, cached intelligence, and peppier launch polish.

## What changed

1. Added a reusable Ms. Minutes loading overlay with relevant messages for refresh, transcript loading, AI summary loading, meeting prep, imports, and thread intelligence.
2. Made the visual theme more vibrant and youthful while staying professional: warmer orange/yellow accents, livelier background, softer cards, and consistent dark date tiles.
3. Added a shared user topbar partial so Meetings, Threads, Thread Detail, Intelligence, Transcript, Summary, Home, and Coming Soon use the same navigation structure.
4. Removed the awkward Intelligence explanation text about attendee matching / wrong laptops and replaced it with cleaner product copy.
5. Added recurring thread auto-linking: when a thread has recurring matching enabled, opening the thread checks for newly available transcript meetings with the matching normalized title and links them automatically.
6. Added recurring auto-link status UI in the Linked meetings card: last checked, newly added count, Check now, and Turn off.
7. Added cached thread quick intelligence. Last meeting, What changed, Follow-ups, Recent progress, and Risks/decisions now return the saved answer when sources have not changed, and show generated timestamp + refresh option.
8. Added cached meeting prep. Help me prepare now stores a meeting-level prep answer and reuses it for participants who can access the meeting context, unless source history changes or the user refreshes it.
9. Added .ics calendar invite import for forwarded / old meetings that were not in the user calendar. Import is available from Meetings, Intelligence, and inside a Thread.
10. Imported .ics files create an EventCache meeting shell; when imported inside a thread, the thread gets a calendar invite entry as context.
11. Added iCalUId and seriesMasterId fields to EventCache for better shared meeting prep keys over time.
12. Kept future-meeting transcript safety from v28.5.

## Validation

- node --check routes/user.js
- node --check models/EventCache.js
- node --check models/IntelligenceCache.js
- node --check models/MeetingThread.js
- node --check server.js
- node --check utils/openaiSummary.js
- EJS compile check for all views
