# v23.3.1 - Node 16 compatible install patch

This patch keeps the v23.3 thread-scoped chatbot behavior and fixes the slow/noisy npm install seen on Node v16.17.1.

## What changed

- Relaxed package engine from `node: 20.x` to `>=16.17.1 <21`.
- Pinned `mongoose` to `7.8.7` to avoid MongoDB/BSON engine warnings on Node 16.17.1.
- Pinned `connect-mongo` to `4.6.0` for better Node 16 compatibility.
- Removed unused `openai` SDK dependency because the app already calls OpenAI through `node-fetch` in `utils/openaiSummary.js`.
- Removed old `package-lock.json`; regenerate it locally using your Node version.

## Recommended install

```bash
rmdir /s /q node_modules
if exist package-lock.json del package-lock.json
npm install
npm start
```

## Note

Railway can still use Node 20 through `nixpacks.toml`. Local Windows Node 16.17.1 is now supported for development installs.
