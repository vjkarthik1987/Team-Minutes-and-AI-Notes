# v27.8 — Thread meeting modal + duration-based summaries

## Summary generation
- Changed the AI summary output shape to three parts:
  1. Summary
  2. Actions
  3. Detailed notes
- Summary bullet count is now based on actual meeting duration: round(duration minutes / 10), minimum 2.
- The generation pipeline still uses the existing OpenAI path and works with `gpt-4o-mini`.
- The prompt now pushes for richer action capture and detailed notes while keeping the top summary short.

## Threads
- Added Add meetings modal on thread detail page.
- Meeting search starts after 3 characters.
- Selected meetings appear as removable chips.
- Added recurring meeting option: when checked, Ms. Minutes links selected meetings plus similar recurring meetings based on normalized subject matching.
- Added Add to thread modal on the AI summary page.

## Collaborators and private notes
- Collaborator search now uses registered users in the same org / tenant and is placed before the `/people/:email` redirect so it actually responds.
- Thread context uses card buttons instead of a dropdown.
- Added Personal note mode. Personal notes are stored as private and shown only to the creator.

## UI
- Added card-style context buttons.
- Added modal styling for add-to-thread and add-meetings flows.
