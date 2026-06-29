# V27.5 — Summary Quality + Editability

## What changed

- Aligned the AI summary page width with the rest of the Ms. Minutes layout.
- Added Logout to all simplified user pages: meetings, transcript, summary, threads placeholder, intelligence placeholder, and home.
- Added an Edit summary flow:
  - Open AI Summary
  - Click Edit summary
  - Change text in a large editor
  - Save back to the same Transcript.ai.summary field
- Improved the 3-pass summary generation prompt:
  - Uses the Microsoft Teams-style structure shared by Karthik as the target.
  - Captures many more explicit and strongly implied follow-up tasks.
  - Adds speaker-attribution rules because Teams transcripts can label multiple people as the signed-in user.
  - Tells the model to infer speaker/owner cautiously from nearby dialogue, direct address, and context.
- Improved summary parser so the generated disclaimer does not become its own fake section.
- Added a short in-memory meeting-card cache to reduce repeated DB work during dynamic search and lazy loading.

## Suggested model setup

Keep the app configurable through `.env`:

```env
OPENAI_MODEL=gpt-4o-mini
OPENAI_SUMMARY_MODEL=gpt-5.4-mini
SUMMARY_CHUNK_CHARS=11000
SUMMARY_MAX_CHUNKS=14
MEETING_CARD_CACHE_MS=45000
```

For best summaries, use a stronger model for `OPENAI_SUMMARY_MODEL` while keeping smaller models for simple UI/search workloads.
