# v29.4 — Thread Last Meeting Intelligence Cleanup

## What changed

1. **Last Meeting now includes What to Ask**
   - The thread **Last meeting?** quick intelligence now always returns a practical **What to Ask** section.
   - Questions are grounded in the latest linked meeting and material thread notes/updates added after that meeting.

2. **System noise removed from thread intelligence**
   - AI no longer uses admin/system entries such as:
     - collaborators added/removed
     - thread created/updated
     - auto-linked recurring meetings
     - imported invite logs
   - These are still useful operational events, but they should not appear in executive prep.

3. **Recent thread context cleaned up**
   - The visible Recent thread context panel now focuses on meaningful notes, MoMs, progress, follow-ups, risks, decisions, and discussions.
   - Internal maintenance entries are hidden from the main context feed.

4. **Cache invalidated for Last Meeting prompt**
   - Last Meeting uses a new v29.4 prompt hash, so old cached answers are not reused.

## Validation

- `node --check routes/user.js`
- `node --check utils/openaiSummary.js`
- `node --check server.js`
