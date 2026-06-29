# v30 — MVP Readiness

This release focuses on trust, onboarding, admin visibility, and launch readiness.

## User-side trust and review
- AI summaries can now be marked as reviewed.
- Edited summaries are automatically treated as human-reviewed.
- Thread quick intelligence and meeting prep answers can be marked as "Looks good" or "Needs correction".
- AI summary pages now include a report-issue flow.
- Thread intelligence popups now include a report-issue flow.

## Thread usability
- Threads now show a freshness indicator: Fresh, Quiet, Needs nudge, or Stale.
- Empty linked-meeting and context states now guide users toward the next action.

## First-time user onboarding
- Home page now shows a small setup checklist until the user has refreshed meetings, opened transcripts, generated summaries, created a thread, and added context.

## Admin/org readiness
- New issue report model and org issue dashboard.
- Org dashboard now includes launch readiness checklist.
- Org dashboard now shows open issues, users never logged in, reviewed summaries, and intelligence usage.
- New usage/adoption dashboard with active users, refresh users, summaries, reviewed summaries, threads, intelligence answers, top users, and top pages.
- Error and issue visibility is now linked directly from the org dashboard.

## Validation
- `node --check` passed for main routes/models/server.
- EJS compile check passed across all views.
