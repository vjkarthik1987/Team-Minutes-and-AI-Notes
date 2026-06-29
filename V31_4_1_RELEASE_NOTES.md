# v31.4.1 — Meeting Date Tile Fix

Immediate visual correction after v31.4.

## Fixed

- Restored the meeting date tile to the left/top area of meeting cards on laptop and larger screens.
- Kept the clearer date/time pills below the title, but made the original date tile visible again so the card scans properly.
- Ensured tablet cards also keep the date tile visible.

## Validation

```powershell
node --check routes/user.js
node --check routes/org.js
node --check server.js
```
