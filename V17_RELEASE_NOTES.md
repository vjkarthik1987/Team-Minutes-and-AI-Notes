# v17 — Conversational Assistant Actions

This release makes Kili more operationally intelligent, not just a Q&A layer.

## Chatbot intelligence

- Kili now detects action-item creation intent from natural messages such as “Assign an action item”.
- If required fields are missing, Kili asks follow-up questions instead of guessing.
- Action creation now requires:
  - action text
  - owner/person
  - due date
- Kili creates the action only once the required details are available.
- Kili detects note/call/manual-meeting capture intent from chat.
- If note details or people are missing, Kili asks the right follow-up questions.

## Notes and memory

- The global Add a note panel now supports:
  - personal memory / reminder
  - call note
  - manual meeting
  - general note
  - generated/cleaned note
- Notes now support people involved.
- People can be searched and added as removable chips.
- Notes are stored as MeetingContext so they enter the same RAG/context layer.

## People handling

- Added `/user/people/search` endpoint.
- People search works after typing 3 characters.
- Selected people become chips with remove buttons.

## Grounding

- Uses the existing models for ActionItem, MeetingContext, ChatMessage, User, and AuditLog.
- Chat-created actions and notes are audit logged.
