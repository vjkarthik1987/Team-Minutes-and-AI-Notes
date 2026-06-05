# v23 — Thread War-Room + Smarter Assistant

## What changed

### Thread War-Room
- Added a War-Room section inside each thread.
- Shows health label/score, what changed, unresolved items, decision pressure, risks, blockers and decisions.
- Added one-click recurring meeting auto-linking from the thread page.
- Added downloadable thread closure report.

### Day Command page
- Moved Today/Tomorrow, Preparation and Actions out of the Home page.
- Added a new sidebar item: Day Command.
- Home now stays focused on the Executive Brief and links to Day Command.

### Smarter chatbot
- Added chat modes: Auto, Brief, Thread, Action and People.
- Chatbot can now answer from the operating graph: actions, owners, people, blockers, threads and metrics.
- Keeps transcript RAG as fallback, but uses operational context first for execution questions.

### Thread metrics graphs
- Added more graph choices for thread metrics:
  - line
  - bar
  - area
  - step
  - pie/share list
  - cumulative
  - scatter
  - gauge/progress

## Suggested tests
1. Open Home and confirm it mainly shows the executive brief.
2. Open Day Command from the sidebar and confirm Today/Tomorrow, Preparation and Actions appear there.
3. Open a thread and confirm Thread War-Room appears.
4. Add risks, blockers and decisions to a thread and confirm they group correctly.
5. Add/update thread metrics and switch graph types.
6. Use Auto-link recurring meetings on a thread.
7. Download a thread closure report.
8. Ask Kili: “Who owns what?”, “Which actions are blocked?”, “What is slipping in this thread?”, “Show metric trend for this thread.”
