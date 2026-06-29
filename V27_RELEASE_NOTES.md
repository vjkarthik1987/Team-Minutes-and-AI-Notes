# v27 - Simple meeting-first reset

This release intentionally removes the heavy user-side experience and keeps the product simple.

## User flow
- Office 365 login remains unchanged.
- User lands on the simple home hub.
- Meetings opens a 60-day meeting-card list.
- Each meeting card shows title, date, time, Transcript, and AI Summary actions.
- No sidebar or chat panel on the simplified user pages.
- Back and Home controls are available on meeting, transcript, and summary pages.

## Preserved
- Existing MongoDB models and database are preserved.
- Admin views are untouched.

## Simplified / removed from visible user flow
- Old user calendar, dashboard, actions, people, settings, assistant, audit, summaries, and detailed thread pages are no longer part of the visible v27 flow.
