# app-v5-meeting-memory

## What changed in v5

### 1. Universal layout
- Same sidebar across Home, Calendar, Action Items, Meeting Threads, and transcript pages.
- Chat window is available across pages.
- Chat occupies around 40% of the workspace, with page content in the remaining area.

### 2. Sync animation + background transcript load
- Sidebar has **Load transcripts**.
- The button animates while loading.
- `/user/transcripts/load-all` starts the transcript sweep in the background.
- `/user/transcripts/load-status` reports status.
- The scheduled worker still runs every 3 hours.

### 3. Transcript intelligence pipeline
For each transcript-loaded meeting, the system now prepares:
- Transcript document
- Transcript chunks for RAG retrieval
- AI summary
- Detailed notes
- Action items

The default `.env.example` now enables detailed notes generation during sweep.

### 4. Shared transcript access
A transcript is stored once per meeting occurrence/transcript.
If A, B, and C are attendees, the transcript ACL is shared with those participants.
When B or C logs in later, the system should not regenerate the same transcript; it updates/uses the shared ACL.

### 5. Correct latest/previous meeting resolver
The v5 resolver fixes questions like:

> give me summary of last weekly leadership call

It now resolves by:
1. detecting the topic/title terms, for example `weekly leadership`
2. filtering accessible transcripts matching that topic
3. sorting by actual meeting start date descending
4. selecting the newest occurrence

So the latest May meeting should win over an older January meeting when both match the same topic.

### 6. Action Items page
- Sidebar link: **Action Items**
- Shows AI-generated action items from meetings the user can access.

### 7. Persistent chat
- Per-user chat history stored in MongoDB using `ChatMessage`.
- Sidebar chat has a **Clear** button.

### 8. Meeting connections / threads
- Sidebar link: **Meeting Threads**
- Create a thread by selecting meetings in sequence.
- Generate AI continuity summary:
  - What changed
  - What progressed
  - What is still pending
  - Decisions changed/confirmed
  - Carried-forward action items
  - Risk movement

## Important env values

```env
ENABLE_TRANSCRIPT_SWEEP=true
TRANSCRIPT_SWEEP_EVERY_HOURS=3
TRANSCRIPT_SWEEP_LOOKBACK_DAYS=30
SWEEP_GENERATE_AI=true
SWEEP_GENERATE_DETAILED_NOTES=true
SWEEP_GENERATE_ACTION_ITEMS=true
```

Microsoft Graph scopes must include calendar and transcript permissions:

```env
OIDC_SCOPES=openid profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/OnlineMeetings.Read.All https://graph.microsoft.com/OnlineMeetingTranscript.Read.All
```

## Test prompts

- Give me summary of last weekly leadership call
- What changed between these connected leadership calls?
- What are my open action items?
- What progressed in the last e-invoicing meeting?
- What risks are still pending from the previous call?
