# Ms. Minutes v31 — Executive Memory + Assistant Desk

This release turns Ms. Minutes from a meeting notes MVP into an executive memory and preparation system.

## Added

### 1. Manual Meeting Links
- New `/user/meeting-links` page.
- Users can manually connect two meetings even when title/participants are different.
- Relationship types: precursor, follow-up, continues, provides context, resulted from, related.
- Meeting cards now include **Connect**.
- Linked meetings are used as trusted context during meeting preparation.

### 2. Assistant Desk
- New `/user/assistant` page.
- Assistants can add questions, prep notes, risks, follow-ups and decision reminders for key people.
- Privacy guard: assistant notes do not grant transcript/summary access.
- Principals can view inputs prepared for them and mark notes as seen.

### 3. My Settings / Profile
- New `/user/settings` page.
- Profile and meeting preference controls.
- Users can add/remove their own assistants.
- Users can see people they assist.

### 4. Org Assistant Management
- New `/org/assistants` page.
- Org admins can centrally assign assistants to key people.
- Assistant mappings sync with legacy collaborator data for backward compatibility.

### 5. What Did I Discuss?
- New `/user/recall` page.
- Search by topic and time range across accessible transcripts, summaries, thread notes, context notes and Assistant Desk notes.
- Output is structured as discussion summary, themes, timeline, decisions, open questions, what to ask next and sources.

### 6. Production Health
- New `/org/health` page.
- Shows MongoDB/config health, Graph/OpenAI setup, transcript sweep settings, environment, users, meetings, transcripts, assistant mappings, open issues and errors.

### 7. Manual Transcript Check
- Meeting cards now include **Check transcript** for a single meeting occurrence.
- Useful when a meeting has just ended and the user wants to check one occurrence without refreshing everything.

### 8. Admin UI Polish
- Shared admin nav partial across org pages.
- Same admin pills/order everywhere.
- Added Assistants and Health nav items.
- Activity/log pages are more compact.
- Fixed bloated cards, whitespace, horizontal overflow, and floating footer behavior.

## Validation
- `node --check routes/user.js`
- `node --check routes/org.js`
- `node --check models/AssistantMapping.js`
- `node --check models/AssistantNote.js`
- `node --check models/MeetingLink.js`
- `node --check models/User.js`
- `node --check server.js`
- EJS compile check across all views
