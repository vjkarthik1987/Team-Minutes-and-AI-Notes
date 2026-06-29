# v8 CEO Meeting OS update

## Added
- User login log model and `/org/login-logs` page for org/superadmin visibility.
- User workspace now uses a clean top navigation only, with no permanent left sidebar or right sidebar.
- Floating 100% height chat dock for follow-ups and action assignment.
- Separate `+ Action Item` flow at `/user/actions/new` with a cleaner form.
- Action Items page converted into grouped table sections by meeting/thread.
- Org bulk user upload page at `/org/users/bulk` with CSV format and browser-side file-to-text loading.
- Calendar page converted into tabs: all meetings, with transcript, without transcript, and connect.
- Meeting cards now support add context/files, link manual transcript, connect workflow, ask follow-up, and send transcript/action pack.
- Chatbot deterministic action creation for prompts like: `create action item send pricing deck to Anu by Friday`.
- Daily/weekly CEO summary scheduler scaffold: weekdays 7:00 AM IST daily digest, Sunday 7:00 AM IST weekly digest. It sends to active `ceo` and `super_admin` users with stored Graph tokens.

## CSV format
```csv
name,email,role,status,canAssignActions,canAssignFollowups,canViewAuditLog
Karthik,karthik@suntecgroup.com,general_user,active,true,true,false
Anu,anu@suntecgroup.com,ceo,active,false,false,false
```

## Notes
- Sending meeting packs and CEO digests needs Graph mail permission/scopes and a valid stored delegated token.
- Calendar meetings without transcripts appear after a refresh for cached online meetings checked through Graph.
