# v23.3 — Thread-Scoped Meeting Prep Chatbot

## Main fix
Meeting-prep questions now resolve the specific upcoming/recurring meeting first and answer only from that meeting thread.

Example:
> What items should I plan for Daily Call with NK tomorrow?

The chatbot now:
1. Detects the target upcoming meeting from tomorrow's calendar.
2. Matches previous occurrences using subject/title continuity.
3. Retrieves only those matched previous occurrences.
4. Sends a strict thread-scoped context to the AI.
5. Returns sources showing the matched prior meetings.

## Why this matters
This prevents unrelated global RAG matches from contaminating executive prep answers. Topics from other calls, actions, or threads are not included unless they appeared in the matched meeting thread.

## Technical changes
- Added v23.3 meeting-prep intent detection.
- Added title/participant-safe thread matching helpers.
- Added strict thread-scoped prep answer path before operating-graph/global retrieval.
- Preserved fallback behavior if no specific meeting can be resolved.
