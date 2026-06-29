# v28.5 — Thread Owner Controls + Intelligence Calendar + Meeting Card Fixes

## Added

- Thread creator/owner controls on the simple thread detail page.
- Creator can edit thread name, objective/client area, and status.
- Creator can remove collaborators from an existing thread.
- Creator can delete a thread using a soft delete. Linked meetings/transcripts are not deleted.
- Intelligence week-ahead flow now first opens a calendar-style popup showing the next 7 days of meetings before generating the week prep.

## Changed

- Intelligence upcoming meetings now show a tighter focus window:
  - Normally: today + tomorrow.
  - On Friday: today through Monday.
- Meetings page no longer shows future meetings as transcript-ready, even if a duplicated/future event accidentally carries transcript metadata.
- Meeting cards now use a dark date tile with light text for better visual hierarchy.

## Notes

- Prep matching remains conservative: linked thread first, normalized meeting title second, no attendee/organizer/speaker-name matching.
- Deleting a thread is a soft delete so data recovery remains possible at database level.
