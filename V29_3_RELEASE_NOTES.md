# Ms. Minutes v29.3

Hotfix release focused on correctness and thread permissions.

## Transcript occurrence matching

- Fixed duplicated Teams meetings that reuse the same Teams link.
- Transcript availability is now matched to the exact calendar occurrence using the meeting start/end time and Graph transcript timing.
- Same Teams link alone is no longer enough to show `Transcript ready` or `AI Summary`.
- Same-day duplicated meetings are handled by matching the transcript closest to the specific event window.
- If the same Teams link has an older transcript but no transcript for this occurrence yet, the app now shows a safe “not ready for this occurrence” response instead of opening the old transcript.
- Cached transcript flags are revalidated against occurrence time to avoid stale wrong links.

## Thread note permission hotfix

- Fixed a bug where the thread creator could be blocked from adding notes with “Only thread collaborators can add notes.”
- The creator/owner is now treated as a contributor for note creation, even if older thread role fields are incomplete.

## Data model additions

- Event transcript refs can now store transcript created/start/end timestamps.
- Transcript records can now store Graph transcript created/start/end timestamps for future-safe occurrence matching.
