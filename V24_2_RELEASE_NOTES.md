# v24.2 — Home refresh + intelligence-first threads

## Changes
- Added a home action to refresh calendar meetings via the existing calendar refresh flow.
- Increased desktop sidebar width for better label readability.
- Reworked home Threads area into a 3-column grid with taller thread cards.
- Started the Thread Intelligence Core model in the thread detail page:
  - linked meetings and transcripts
  - dated AI summaries/detailed notes per meeting
  - additional human context
  - follow-up/action entries with owner and next follow-up date
  - editable human insight stored on the thread AI object
- Made the copilot close button more prominent.

## Notes
This version keeps existing backend compatibility and extends the existing MeetingThread schema rather than introducing a new collection.
