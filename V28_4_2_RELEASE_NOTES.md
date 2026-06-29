# v28.4.2 — Org Nav Below Hero

Small admin shell layout fix.

## Changes
- Removed the org/admin navigation pills from the top header row.
- Moved org/admin navigation below the hero card on org pages.
- Header now stays clean with only Ms. Minutes Admin branding and org/logout controls.
- Added a soft pill-strip navigation below the hero card for Dashboard, Users, Bulk upload, Activity logs, Login logs, Diagnostics and Settings.
- Applied the same below-hero navigation pattern to org subpages so the links are still reachable from the UI.

## Validation
- `node --check server.js`
- `node --check routes/org.js`
- `node --check routes/auth.js`
- `node --check models/PageVisitLog.js`
