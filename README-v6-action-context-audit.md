# v6 — Action assignment, meeting context, audit log, user edit

Built on v5 Meeting Memory.

## Added

1. Chat panel remains globally available from the shared layout, so the input box is present across authenticated pages.
2. Chat answers now include recent chat history as lightweight conversational memory for follow-up questions, while transcript chunks remain the evidence source.
3. Manual action assignment: permitted users can assign action/follow-up items to people.
4. Action items can be linked to a saved transcript/meeting or created independently.
5. Recurring action metadata added: daily, weekly, monthly, interval, nextDueAt.
6. Superadmin/org admin can grant users assignment and audit-log permissions.
7. Home right content replaced with Today’s Meetings + previous context cards.
8. Calendar includes a direct “Connect previous meetings” path.
9. Meeting Threads copy/UI updated to emphasize recurring-meeting continuity.
10. Superadmin audit log page added at `/user/audit`.
11. Org user edit flow added at `/org/users/:id/edit`.

## New/changed data

- `models/AuditLog.js`
- `User.permissions.canAssignActions`
- `User.permissions.canAssignFollowups`
- `User.permissions.canViewAuditLog`
- `ActionItem.source`
- `ActionItem.assignedBy*`
- `ActionItem.dueDateISO`
- `ActionItem.recurrence.*`

## Main routes

- `GET /user/home` now prepares today/context cards.
- `POST /user/actions` manually creates action items.
- `GET /user/audit` shows recent audit logs for superadmin/audit-permitted users.
- `GET /org/users/:id/edit` and `POST /org/users/:id/edit` edit users.
