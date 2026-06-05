# v16.5 — Personal Notes, Better Settings, Recurring Colour, Latest-First Intelligence

## What changed

1. **Add a note / personal memory**
   - New global sidebar button: `+ Add a note`.
   - Notes are saved as private `Personal note` context and enter the same RAG memory layer.
   - Supports reminder-style text such as “remember me till tomorrow / next Friday / 2026-05-30”.
   - Kili routes remember/remind/note questions to personal-note RAG instead of transcript fallback.

2. **Home cleanup**
   - Removed the home text: “Transcript AI load runs every 2 hours. Use the sidebar button for manual catch-up.”

3. **My Settings polish**
   - Upgraded visual treatment for the settings page and collaborator cards.
   - Collaborator management remains the user’s personal shortlist for delegates/assistants.

4. **Recurring meeting highlighting**
   - Recurring-style meetings now show a different visual treatment on Home.
   - Recurring threads also get a distinct card style.

5. **Latest-first retrieval intelligence**
   - For questions like “What is the outcome of the latest Weekly Leadership meeting?”, Kili now prioritizes newest strong title/topic matches over older meetings with richer text.
   - Personal memory queries no longer get hijacked by latest transcript fallback.

## Test checklist

- Add a personal note from sidebar and ask: “What did I ask you to remember?”
- Add a note with “till tomorrow” and confirm it is stored as active personal memory.
- Open Home and confirm the transcript-load explanatory line is gone.
- Open My Settings and confirm the page looks more polished.
- Check Daily/Weekly recurring meetings on Home for the new recurring visual treatment.
- Ask: “What is the outcome of the latest Weekly Leadership meeting?” and confirm the newest accessible matching meeting is selected.
