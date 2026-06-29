# Ms. Minutes v28.3.1

Small Intelligence UI polish release.

## Changes
- Reworked upcoming-meeting cards on the Intelligence page into a compact 3-column layout.
- Fixed title wrapping caused by shared meeting-card date styles bleeding into the Intelligence card.
- Date tile, meeting details, and Help me prepare button now stay visually connected.
- Reduced empty whitespace in upcoming meeting cards.
- Help me prepare button now sits neatly on the right and only uses the required width.

## Validation
- `node --check routes/user.js`
- `node --check utils/openaiSummary.js`
- `node --check server.js`
