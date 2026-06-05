# v19 — Stabilization + Trust Release

## What changed

- Production-safe sessions continue to use `connect-mongo` with MongoDB, avoiding Express MemoryStore warnings in Railway.
- Added `/health` and `/healthz` endpoints for Railway health checks.
- Added Org Admin Diagnostics screen at `/org/diagnostics`:
  - Microsoft Graph configuration status
  - OpenAI/AI configuration status
  - MongoDB-backed session store status
  - Transcript sweep counters
  - AI index counters
  - Recent sync state per user
  - Recent error preview
- Added Error Logs UI at `/org/errors`:
  - Route, method, status, actor, message, stack in non-production
  - Resolve button for reviewed errors
- Added persistent `ErrorLog` model and global Express error logger.
- Added retry support for failed transcript/AI jobs from diagnostics.
- Added “Why did AI answer this?” source trace in the chat UI, showing the meetings/notes/context used as evidence.

## Test checklist

1. Start locally and confirm no `MemoryStore` warning appears.
2. Open `/health`; expect JSON with `sessionStore: MongoDB` and DB status.
3. Log in as org admin and open `/org/diagnostics`.
4. Trigger or inspect recent sync state after loading AI/transcripts.
5. Open `/org/errors`; it should show either no errors or recent captured errors.
6. Ask Kili a meeting-memory question and expand “Why did AI answer this?” under the response.
7. If there are failed transcript/AI jobs, click “Retry failed transcript/AI jobs”, then run/load transcript memory again.

## Railway health check

Use `/health` as the Railway health path.
