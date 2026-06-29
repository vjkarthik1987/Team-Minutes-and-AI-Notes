# v31.1 — Mobile polish, smarter recall, admin cleanup

## Fixed / improved

1. **Mobile collapsible menus**
   - User navigation now collapses behind a Menu button on mobile.
   - Org/admin navigation now collapses behind an Admin menu button on mobile.
   - Applied through shared partials so every user/admin page inherits it.

2. **Mobile meetings layout**
   - Meetings remain one card per row on mobile.
   - Meeting action buttons are horizontally aligned and scroll safely on narrow screens.

3. **Smarter “What did I discuss?” recall**
   - Topic recall now uses stricter relevance scoring.
   - Multi-word topics like “platform roadmap” require stronger topic relevance instead of returning every incidental mention.
   - Recall context now uses relevant snippets rather than dumping broad meeting text.
   - Prompt now instructs AI to synthesize the actual discussion, decisions, open questions, and next asks rather than listing all meetings.

4. **Home page compact 3 + 2 layout**
   - Five home cards now appear as 3 cards on the first row and 2 cards on the second row on desktop.
   - Cards are smaller to fit better on one screen.

5. **Meetings action row**
   - Transcript, AI Summary, Connect, and Check transcript are kept in one row on desktop.

6. **Better recall form**
   - Cleaner large topic search field.
   - Better date/scope layout.
   - Added quick topic chips.

7. **Assistant Desk spacing**
   - Added clearer spacing between Add assistant note, Inputs for me, and Notes I submitted.

8. **Activity log cleanup**
   - More compact filter bar.
   - Top page cards limited to three to avoid partial overflow.
   - Activity table now has fixed-width columns and safer wrapping.

9. **Registry URL fix**
   - package-lock internal registry URLs replaced with public npm registry URLs.
   - .npmrc explicitly points to npmjs registry.

## Validation

- `node --check routes/user.js`
- `node --check routes/org.js`
- `node --check server.js`
- `node --check models/AssistantMapping.js`
- `node --check models/AssistantNote.js`
- `node --check models/MeetingLink.js`

EJS runtime compile was not run in the sandbox because node_modules was not installed.
