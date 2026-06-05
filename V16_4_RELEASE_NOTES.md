# v16.4 — Settings, Collaborators, Recurring Chains, Thread CRUD, AI Resilience

## Added
- User Settings page under `/user/settings`.
- Personal collaborator/delegate management for assistants, PMs, or trusted contributors.
- Thread delete action for creator/owner. Threads are soft-deleted; transcripts and meetings remain intact.
- Recurring meeting chain connector inside thread detail.
  - Connects repeated meetings by stable subject key.
  - Stores chain metadata and meeting-to-meeting links.
  - Updates linked meeting cache where possible.

## Improved
- Thread list excludes deleted threads.
- Thread detail has a recurring-chain panel and danger zone for deletion.
- Sidebar navigation now includes Settings.

## AI reliability fixes
- OpenAI calls now retry transient server/rate/timeout failures with backoff.
- Request-ID-heavy OpenAI errors are cleaned before display/logging.
- Thread AI summary now has deterministic fallback output instead of leaving the user with only an error.
- Transcript sweep action-item generation now marks failed attempts and applies cooldown, so the same transcript is not hammered every 2 hours after a transient OpenAI failure.

## Testing checklist
1. Open `/user/settings`, add/remove a collaborator.
2. Create a thread, add contributors/viewers, then delete as owner.
3. Try deleting as non-owner — should be blocked.
4. Open a thread with recurring meetings, run “Connect recurring meetings”.
5. Refresh AI Summary when OpenAI fails or is flaky — thread should still get a fallback readout.
6. Run transcript sweep twice after an action-item AI failure — second run should defer due to cooldown instead of repeating the same error storm.
