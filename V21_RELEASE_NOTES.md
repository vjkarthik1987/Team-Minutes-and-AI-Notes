# v21 — Action Intelligence 2.0 + Thread Metrics

## What changed

### Action Intelligence 2.0
- Added `Waiting` to the action lifecycle: Open, In Progress, Waiting, Done, Dropped.
- Added action progress comments/updates.
- Added action escalation with escalation note, escalation timestamp, and audit entry.
- Added action reassignment from the actions UI.
- Improved recurring action visibility.
- Added action digest counters: overdue, stale/no update, waiting, escalated, recurring.
- Added stale action detection based on no update for 5+ days.

### Thread metrics and trend graphs
- Added `ThreadMetric` model.
- Thread owners/contributors can create metrics for a thread.
- Metrics support regular updates with value, date, and note.
- Supported chart styles: line trend and bar trend.
- Supported trend direction: higher is better, lower is better, neutral.
- Thread detail page now shows metric trend graphs.
- Example metrics: defects closed, blockers cleared, open defects, SLA breaches, pending approvals, release readiness score.

### Thread execution stats
- Thread detail now shows action-level operating stats:
  - total actions
  - open/active actions
  - waiting actions
  - overdue actions
  - stale actions

## Key files changed
- `models/ActionItem.js`
- `models/ThreadMetric.js`
- `routes/user.js`
- `views/user/actions.ejs`
- `views/user/thread_detail.ejs`
- `public/css/minimal.css`

## Recommended testing
1. Start app and confirm v20 executive home still works.
2. Open `/user/actions` and verify digest cards appear.
3. Create an action and move it across Open → In Progress → Waiting → Done/Dropped.
4. Add progress comment to an action.
5. Escalate an action.
6. Reassign an action.
7. Create a recurring action and verify it is marked recurring.
8. Open a thread and add a metric such as “Defects closed”.
9. Add multiple metric values across dates.
10. Switch the metric graph between line and bar.
11. Verify only thread owner/contributors can update metrics.
