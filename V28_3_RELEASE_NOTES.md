# Ms. Minutes v28.3 — Intelligence Meeting Prep Cockpit

## What changed

1. Replaced the placeholder Intelligence page with a practical meeting-prep cockpit.
2. Added upcoming meetings for the next 3 days.
3. Added **Help me prepare** for each upcoming meeting.
4. Added **Prepare week** to generate a week-ahead prep brief.
5. Matching logic is intentionally conservative:
   - linked thread first
   - normalized meeting title second
   - no attendee, organizer, or speaker-name matching
6. Prep output uses the latest related meeting as the strongest signal, with the previous two meetings as lower-weight background.
7. Added sources in the prep modal so the user can see which meetings / threads were used.
8. Added a refresh button on Intelligence to pull upcoming Outlook meetings.
9. Updated the Home Intelligence card to position Intelligence as meeting preparation rather than a generic chatbot.

## Notes

- This version does not pretend to have structured action-item tracking yet.
- It generates practical follow-up questions and watch-outs from summaries, transcripts, linked threads, and notes.
- Structured action extraction can come later as a separate layer.
