# Ms. Minutes v27.4 Release Notes

## Focus
This release improves speed and usability of the simplified meeting-first app.

## Changes

### 1. Three-pass AI summary generation
The AI summary generation logic now uses a real three-pass pipeline:

1. **Pass 1 — Chunk extraction**
   - Splits long transcripts into manageable chunks.
   - Extracts chunk-level themes, decisions, follow-up tasks, risks and blockers.

2. **Pass 2 — Consolidation**
   - Deduplicates chunk outputs.
   - Builds a consolidated topic map and task list.

3. **Pass 3 — Final Teams-style summary**
   - Produces a Microsoft Teams-style final recap with topic sections and follow-up tasks.

Existing summaries must be regenerated to use the new logic.

### 2. Dynamic meetings search
- Search now reacts as the user types.
- Search starts after 3 or more characters.
- Results are loaded without a full page reload.

### 3. Infinite scroll / lazy loading
- Meetings page initially renders only the first page of meeting cards.
- More cards load automatically when scrolling down.
- Added a small loading indicator while more meetings are fetched.

### 4. Sticky footer
- Added a quirky footer: `🐣 tiny meeting magic · (c) Karthik`.
- Footer stays at the bottom of the viewport.

### 5. Meetings page performance
- Reduced initial meeting page size from 24 to 18 cards.
- Avoided loading full transcript text while building meeting cards.
- Limited meeting cache query to the 60-day window directly.
- Added a JSON endpoint for paginated meeting search/loading: `/user/meetings/data`.

## Files changed
- `utils/openaiSummary.js`
- `routes/user.js`
- `views/user/meetings.ejs`
- `views/user/home.ejs`
- `views/user/summary.ejs`
- `views/user/transcript_saved.ejs`
- `views/user/coming_soon.ejs`
- `views/layout.ejs`
- `public/css/minimal.css`
- `package.json`
