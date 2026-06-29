# v31.4 — Meetings visibility, cache-only connect, colorful FAQ

## Fixed
- Meeting cards now show date and time as prominent pills inside the card so dates are visible in three-column layouts.
- The Ms. Minutes footer is now non-floating so it no longer covers meeting card buttons or dates.
- Connect meeting search is explicitly cache-only and no longer falls into an error page/modal state when Outlook/Graph is not involved.
- Connect popup is simplified with clearer before/after choices and cached-meeting helper text.
- FAQ page is more colorful and easier to scan.

## Validation
- `node --check routes/user.js`
- `node --check routes/org.js`
- `node --check server.js`
- `node --check models/MeetingLink.js`

EJS runtime compile was not run because `node_modules` is not installed in the sandbox.
