# Ms. Minutes v28

Simple-polish and thread-intelligence release.

## What changed

- Aligned the home page and user-page container widths.
- Removed the Meetings page helper copy under the title.
- Added Outlook refresh nudges:
  - after 7 days: cute dismissible refresh popup
  - after 14 days or never refreshed: forced refresh popup
- Updated Copy Transcript to a two-box copy style button.
- Added Email Transcript button that generates an `.eml` draft-style file with the transcript attached.
- Made Add Meetings modal narrower on thread details.
- Removed duplicate Add Note button from thread details.
- Added attachments to thread notes.
- Added quick thread intelligence buttons:
  - Last meeting?
  - What changed?
  - Follow-ups
  - Risks / decisions

## Notes

Browser `mailto:` links cannot reliably attach files. v28 therefore creates an `.eml` file with the transcript attached, which can be opened in Outlook or the local mail client.
