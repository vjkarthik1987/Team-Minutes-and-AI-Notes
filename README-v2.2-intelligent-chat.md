# app-v2.2-intelligent-chat

## What changed

1. Fixed chat retrieval crash:
   - Replaced `mongoose.Types.ObjectId(id)` with `new mongoose.Types.ObjectId(id)`.
   - This fixes: `Class constructor ObjectId cannot be invoked without 'new'`.

2. Made chat smarter for previous meeting questions:
   - `What was my previous meeting?` now resolves to the latest accessible meeting instead of doing title search.

3. Reduced unnecessary disambiguation:
   - Repeated titles like `Weekly Leadership Call` no longer force the user to pick every time.
   - The system auto-selects the best/latest match and cites the source.

4. Added intent classification:
   - SUMMARY
   - ACTION_ITEMS
   - DECISIONS
   - RISKS
   - WHO_SAID_WHAT
   - MEETING_LOOKUP
   - GENERAL_SEARCH

5. Improved transcript retrieval:
   - Combines transcript text relevance, meeting title match, AI summary match, and recency.
   - For summary/action/decision/risk questions, the UI sends the best resolved meeting to the answer endpoint.
   - For broad/general search, it can still use multiple relevant transcripts.

## Test prompts

- What was my previous meeting?
- What was the summary of the Weekly Leadership Call?
- What were the action items from the latest Weekly Leadership Call?
- What decisions were taken in the Incremental release meeting?
- What risks or blockers were discussed?

## Notes

The chatbot still answers only from stored transcript chunks and allowed transcripts for the signed-in user.
