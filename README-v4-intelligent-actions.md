# app-v4-intelligent-actions

v4 upgrades the meeting intelligence layer.

## What changed

1. Intelligent summaries
   - Summary prompt now produces specific executive-style meeting intelligence instead of generic/random summaries.
   - Includes key outcomes, action items, risks, open questions, and executive readout.

2. Correct previous/last meeting resolver
   - `last weekly leadership meeting` now resolves to the most recent matching meeting, not the oldest matching title.
   - Recurring meetings are sorted by topic/title match first and then start date descending.

3. Action items page
   - New model: `ActionItem`.
   - New sidebar link: `/user/actions`.
   - Action items are generated after transcript ingestion/checks.
   - Items are ACL-scoped to the meeting participants, so one meeting is processed once and accessible to A/B/C without regenerating for each user.
   - Users can update action status: Open, In Progress, Done, Dropped.

4. Admin user types
   - User roles are now:
     - CEO
     - General User
     - Super Admin

## Background transcript sweep

The existing sweep still runs every 3 hours by default:

```env
ENABLE_TRANSCRIPT_SWEEP=true
TRANSCRIPT_SWEEP_EVERY_HOURS=3
SWEEP_GENERATE_AI=true
SWEEP_GENERATE_ACTION_ITEMS=true
```

The sweep:
- finds transcripts,
- stores one transcript per meeting occurrence/transcript id,
- merges attendee ACLs,
- generates chunks,
- generates summary,
- generates action items once.

## Manual command

```bash
npm run sweep:transcripts
```
