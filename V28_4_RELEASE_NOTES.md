# Ms. Minutes v28.4 — Org Admin Launch Cockpit

## What changed

1. Added authenticated page/activity logging.
   - Logs user/org actor, page path, route, method, status, IP, browser, duration and timestamp.
   - Skips noisy background endpoints such as shell polling and chat calls.

2. Added org Activity Logs page.
   - New route: `/org/activity`.
   - Filters by email, page/path, method, actor type and date range.
   - Shows top pages for the last 7 days.

3. Updated org/admin UI styling.
   - Org login and signup now match the Ms. Minutes orange/quirky design language.
   - Org shell/top navigation updated.
   - Org dashboard, users, bulk upload and settings pages polished.

4. Added launch-focused org dashboard metrics.
   - Total users, active/inactive users, users logged in this week, cached meetings, transcript meetings, AI summaries, threads, page visits and open errors.

5. Added proper bulk user CSV template.
   - New route: `/org/users/bulk/template.csv`.
   - UI has Download template button.
   - Template supports name, email, role, status, department, designation and permission flags.

6. Improved bulk upload validation.
   - Checks required columns, valid emails, duplicate emails in the file, allowed org domains and valid roles.
   - Existing users are updated; new users are created.

7. Added department and designation fields to User.

## Validation

- `node --check routes/org.js`
- `node --check server.js`
- `node --check models/PageVisitLog.js`
- `node --check models/User.js`

