# v16.1 — Transcript AI Automation + Useful Notifications

## What changed

1. Transcript AI ingestion is now automatic every 2 hours by default.
   - `TRANSCRIPT_SWEEP_EVERY_HOURS` still overrides the cadence.
   - The default changed from 3 hours to 2 hours.
   - The sweep continues to generate transcript chunks, summaries, detailed notes, and action items.

2. Sidebar now shows global transcript AI controls across all user pages.
   - Load transcripts to AI is available outside Home.
   - Pending transcript count is shown on the button.
   - Last AI load time is shown under the button.
   - Manual load response now reports processed / skipped / failed / pending.

3. Notifications are now global and itemized.
   - The popup shows counts plus the actual overdue, open/assigned, and recently closed action items.
   - Available across all user windows through the sidebar.

4. Home layout cleanup.
   - Removed the Focus signals card.
   - Today & tomorrow, Preparing for today, and Actions now align at the top.
   - Home header now explains that transcript AI load runs automatically every 2 hours.

## Useful env vars

- `ENABLE_TRANSCRIPT_SWEEP=true`
- `TRANSCRIPT_SWEEP_EVERY_HOURS=2`
- `TRANSCRIPT_SWEEP_RUN_ON_START=true`
- `SWEEP_GENERATE_AI=true`
- `SWEEP_GENERATE_DETAILED_NOTES=true`
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-4o-mini`

## What to test

1. Start the app and confirm logs show: `transcript-sweep scheduled every 2 hour(s)`.
2. Open Home, Calendar, Actions, Threads and confirm sidebar shows:
   - Load transcripts button
   - Pending count
   - Last AI load time
   - Notifications button
3. Click Load transcripts and confirm the pending count updates.
4. Open Notifications and confirm actual action items are listed, not just counts.
5. Confirm Focus signals no longer appears on Home.
