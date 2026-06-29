# Ms. Minutes v31.2 — Recall Filters + Admin/User Grid Polish

## What changed

1. **What did I discuss? quick filters**
   - Added one-click range filters: Last 3d, 7d, 15d and 30d.
   - Custom From/To dates still work.

2. **Focus recall on one meeting**
   - Added optional “Focus meeting” selector.
   - Topic recall can now anchor the answer to one particular meeting and connected thread/note evidence.

3. **Admin remove user**
   - Org admin can now remove a user from the users page.
   - Removal is a safe soft-remove: the user is deactivated, hidden from active admin users list, and assistant mappings involving that user are disabled.

4. **Meetings grid on laptop/desktop**
   - Laptop and larger screens now show meeting cards in a 3-column grid.
   - Tablet widths fall back to 2 columns.
   - Mobile remains 1 card per row.

5. **Meeting action buttons**
   - Transcript, AI Summary, Connect and Check transcript stay in one row within the meeting card.

6. **Recall page spacing**
   - Added clearer gaps between the topic/form card, result card and sources card.

## Validation

```bash
node --check routes/user.js
node --check routes/org.js
node --check models/User.js
node --check server.js
```

EJS runtime compile was not run in the sandbox because npm dependencies are not installed there.
