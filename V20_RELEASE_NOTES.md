# v20 — Real Chief-of-Staff Dashboard

This release transforms the home page from meeting memory into an executive operating brief.

## What changed

### Executive Brief Home
- `/user/home` now starts with **Today’s Executive Brief**.
- Shows leadership-first sections:
  - Top 5 focus areas
  - Silent risks
  - People to follow up
  - Meetings that matter
  - Threads slipping
  - Decisions pending
  - Stale actions

### Executive Brief Engine
- Added `services/executiveBrief.service.js`.
- Briefs are precomputed and stored instead of generated live every page load.
- Manual regeneration available from the home page.
- Markdown export available at `/user/executive-brief/download.md`.
- JSON endpoint available at `/user/executive-brief.json`.

### New Intelligence Models
- `ExecutiveBrief`
- `RiskSignal`
- `DecisionItem`
- `ThreadScore`

### Thread Health
- Computes health from unresolved thread entries, risks/blockers, pending decision signals, and inactivity.
- Labels threads as:
  - Healthy
  - Attention Needed
  - Slipping
  - Critical

### Explainability
Every brief item includes:
- Why shown
- Confidence percentage
- Source type/title
- Owner where available

### Scheduled Morning Brief
- Added `jobs/dailyExecutiveBrief.job.js`.
- Generates daily executive briefs at around 6 AM IST when embedded workers are enabled.

## Environment notes
- Existing `START_EMBEDDED_WORKERS=false` disables the scheduled job.
- No new mandatory env variable is required.

## Suggested smoke tests
1. Login as a user.
2. Open `/user/home`.
3. Confirm the executive brief appears above the old meeting/action panels.
4. Click **Regenerate brief**.
5. Click **Copy brief**.
6. Click **Export markdown**.
7. Open `/user/executive-brief.json`.
8. Confirm `/health` still reports version `20.0.0`.
