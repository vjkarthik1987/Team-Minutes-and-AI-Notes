# v14 - Meeting Memory Reliability + Transparency

## Added
- First-login transcript onboarding banner.
- Login count, first-login timestamp and transcript onboarding dismissal.
- Transcript-level action extraction lock so a meeting with five attendees generates AI actions only once.
- Shared transcript lookup before indexing, reducing duplicate transcript/action creation across attendees.
- Stronger meeting-first chat grounding behavior foundation.
- Transparency page showing model configuration and stack.
- Thread sequence linking for preceding/following meetings.
- New home layout:
  - Today & tomorrow meetings
  - Preparing for today from previous context
  - Pending and due-today actions
- Chat panel reduced from 30vw to 27vw.
- Railway/Nixpacks hardening:
  - Node 20 engine
  - public npm registry .npmrc

## Environment
OPENAI_MODEL=gpt-4o-mini
NIXPACKS_NODE_VERSION=20
