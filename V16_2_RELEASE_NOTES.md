# v16.2 — Preparation intelligence and linked-context UX

## Home
- Today’s preparation summary now renders in full, not just a shortened preview.
- Preparation card is now tabbed: Today and Tomorrow.
- Tomorrow’s preparation summary is built from tomorrow’s meetings and any linked context/previous meeting.
- Meeting cards show a small linked-context count badge in the top-right corner.
- Clicking the badge opens a popup with the linked meetings/notes/context items.
- Add context meeting on Home now uses searchable input with datalist instead of a plain dropdown.

## Context linkage
- Linking a context meeting updates the target meeting’s preparation context.
- Tomorrow meetings now benefit from context added today.
- Linked context items include source type and preview in the popup.

## Chatbot grounding
- For direct meeting-name matches, chat now prefers the latest direct subject match before older loosely related matches.
- Strong match answers include latest linked context/preparation notes before transcript summary and raw transcript.
- This improves questions like: “What is the follow-up context and prep for Daily Catch up - Commerz & ING Delivery?”
