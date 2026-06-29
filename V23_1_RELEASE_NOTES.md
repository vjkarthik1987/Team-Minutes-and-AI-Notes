# V23.1 Release Notes

## Login UX cleanup

- Removed workspace/tenant slug entry from the user login screen.
- User login now goes directly to Microsoft 365 sign-in.
- Organization is resolved internally from the signed-in user's email domain.
- Org/Admin login links now point to `/auth/login` instead of `/org/login`.
- Added a backward-compatible `/org/login` redirect to `/auth/login` for old links.

## Architecture note

The tenant/org model is still retained internally for ACL, domain gating, Graph storage, and future expansion. Only the user-facing tenant step has been removed.
