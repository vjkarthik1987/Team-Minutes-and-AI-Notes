# V29.2 Release Notes — Refresh stability, meeting-linked updates, richer thread context

## What changed

1. **Outlook refresh bounded**
   - Meetings refresh and Intelligence upcoming refresh now use bounded Graph calls.
   - Expensive transcript discovery is capped and skipped if it takes too long.
   - Cached meetings still render even if Outlook is slow.

2. **Meeting-linked thread updates**
   - Add Note now has **Related meeting, optional**.
   - A collaborator can add a progress/follow-up/MoM/note tied to a specific linked meeting.
   - Thread intelligence and meeting prep now consider these updates.

3. **Last meeting intelligence now includes post-meeting updates**
   - If notes were added after the latest linked meeting, or linked to that meeting, **Last meeting?** includes them.

4. **Recurring prep improved**
   - When available, recurring series identifiers are used before normalized title matching to find previous instances.
   - No attendee/organizer/speaker matching was added.

5. **Long thread notes are readable**
   - Recent thread context note cards now collapse long MoMs/notes with **Show more / Show less**.
   - Linked meeting chips appear on note cards.

6. **AI summary ready state is colorful**
   - Generate summary remains calmer.
   - Ready AI Summary buttons now use a brighter teal/purple/rose gradient.

7. **Background updated**
   - Body background is now a softer orange → rose → teal aurora, keeping the Ms. Minutes feel without becoming too orange-heavy.

## Validation

- `node --check routes/user.js`
- `node --check utils/openaiSummary.js`
- `node --check server.js`
- EJS compile check across all views
