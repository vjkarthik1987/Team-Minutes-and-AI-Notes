# app-v3-intelligent-chat

## What changed

### 1. Smarter chatbot retrieval
- Topic-aware latest meeting resolver.
- `last weekly leadership meeting` now ranks by title/topic before recency.
- Answers use meeting-level AI summaries + detailed notes + transcript chunks.
- Access is still enforced by `orgId` and `acl.allowedEmails`.

### 2. RAG status
This version implements a practical RAG flow:

`question -> intent detection -> meeting resolver -> transcript chunk retrieval -> context assembly -> grounded AI answer`

It uses Mongo text search + heuristic ranking. Full vector embedding search can be added next, but the answer path is now retrieval-augmented and transcript-grounded.

### 3. Background transcript sweep
- Runs every 3 hours by default.
- Can also run once manually with:

```bash
npm run sweep:transcripts
```

- Uses stored delegated Graph tokens from users who have signed in.
- Stores a transcript once per meeting occurrence/transcript.
- If A, B, and C attended the same meeting, once A's login/sweep creates the transcript, B and C get access through `acl.allowedEmails` and the transcript is not regenerated for them.

### 4. Persistent login
- Sessions now use MongoStore instead of memory sessions.
- Default session TTL is 30 days.
- `rolling: true` keeps active sessions alive.

### 5. UI
- New full-screen v3 home screen.
- Sidebar, 40% chat panel, and future workspace area.
- Minimal margin, quirky visual style, and cleaner chat composer.

## Important env values

```env
SESSION_TTL_DAYS=30
ENABLE_TRANSCRIPT_SWEEP=true
TRANSCRIPT_SWEEP_EVERY_HOURS=3
TRANSCRIPT_SWEEP_RUN_ON_START=true
TRANSCRIPT_SWEEP_LOOKBACK_DAYS=30
SWEEP_GENERATE_AI=true
```

Microsoft scopes should include:

```env
OIDC_SCOPES=openid profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/OnlineMeetings.Read.All https://graph.microsoft.com/OnlineMeetingTranscript.Read.All
```

## Notes

If Microsoft Graph refuses transcript APIs, check Azure app permissions/admin consent for transcript access. The app will not fabricate answers when transcript content is unavailable.
