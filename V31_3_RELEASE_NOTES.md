# v31.3 — Meeting Graph + FAQ + Mobile Readability

## What changed

1. Removed the Check Transcript button from meeting cards.
2. Added a detailed FAQ page at `/user/faq`.
3. Rebuilt meeting connection from meeting cards as a modal:
   - This meeting is a precursor of another meeting
   - This meeting is a successor of another meeting
   - Search target meetings by typing 3+ letters
4. Manual meeting links now support future cached meetings.
5. Manual meeting links are visible to people in the connected meetings through meeting attendee/organizer ACL.
6. Users can remove only the meeting links they created.
7. Meeting links behave as a network: X → Y → Z can be used as indirect context.
8. Mobile transcript and AI summary text is larger and easier to read.
9. Mobile pinch-zoom disabled through viewport and touch-action rules.
10. `/user/login` rebuilt as a minimal centered animated login page.
11. Thread notes created by the user can be edited or deleted from the thread page.
12. Recent thread context now tries to show up to 7–10 useful context cards by supplementing notes with linked meeting summary context.

## Validation

- `node --check routes/user.js`
- `node --check models/MeetingLink.js`
- `node --check models/MeetingThread.js`
- `node --check server.js`
