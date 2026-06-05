# v14.1 - Home and Calendar Context UX Fixes

## Fixes
- First-login transcript onboarding now disappears after transcript/AI context loading.
- Calendar and home meeting cards can link a preceding/context meeting.
- Preparing for today now starts with a popup summary card.
- Added vertical spacing above the preparation column.
- Meeting times render in the user's local browser timezone.
- Removed raw ISO timestamps from visible meeting cards where possible.

## Compatibility
- Package versions are adjusted back toward Node 16 compatibility:
  - mongoose 8.x instead of 9.x
  - connect-mongo 5.x instead of 6.x
  - express 4.x instead of 5.x
  - bcrypt 5.x instead of 6.x
