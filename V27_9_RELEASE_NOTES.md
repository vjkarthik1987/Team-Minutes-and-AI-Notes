# V27.9 — Collaborator management + note modal polish

## What changed

### Existing thread collaborators
- Added an **Add collaborators** button at the top of the thread detail page.
- Opens a modal with registered-user typeahead.
- Search starts after 3+ characters.
- Selected people appear as removable chips.
- Any existing collaborator/member can add more collaborators.
- Added users are added to contributor/member lists and ACL access.

### Registered users only
- Collaborator lookup now uses registered users in the same org/tenant.
- Manual arbitrary email entry has been removed from create-thread collaborator input.
- User search allows existing users where status is not inactive, to avoid missing older registered users without an explicit active status.

### Add Note flow rebuilt
- Replaced the inline context form with a clean **Add Note** button.
- Add Note opens a modal form.
- Note type selection is inside the modal.
- Supported types:
  - Note
  - Personal note
  - Follow-up
  - Discussion
  - MoMs
  - Progress
- Personal notes remain private to the creator.
- Form fields adapt based on note type.

### Thread schema
- Extended thread entry kinds for follow-up, discussion, MoMs, and progress.
- Follow-up items count as open actions unless marked complete/done/closed.
