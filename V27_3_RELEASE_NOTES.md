# V27.3 Release Notes — Hover polish, transcript copy, Teams-style summaries

## What changed

1. Removed hover underline from the home cards/buttons
   - Meetings, Threads, and Intelligence cards no longer show the ugly black underline on hover.

2. Added Copy Transcript
   - Saved transcript page now has a copy button next to AI Summary and Download Transcript.
   - Uses navigator.clipboard with a fallback for older browsers.

3. Improved AI summary generation style
   - Summary prompt now asks for a Microsoft Teams-style recap.
   - Structure is now:
     - Meeting notes
     - Thematic sections
     - Concrete sub-points
     - Follow-up tasks
   - Designed to capture more of long leadership calls instead of a thin executive summary.

4. Improved AI summary page rendering
   - Summary now shows topic blocks and bullet rows more cleanly.
   - Follow-up tasks are visually separated.

5. Added Regenerate summary
   - Existing old summaries can be regenerated using the new format from the summary page.

## Files changed

- `public/css/minimal.css`
- `views/user/transcript_saved.ejs`
- `views/user/summary.ejs`
- `routes/user.js`
- `utils/openaiSummary.js`
- `views/layout.ejs`
