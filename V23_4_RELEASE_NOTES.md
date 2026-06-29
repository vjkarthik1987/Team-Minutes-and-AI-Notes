# v23.4 — Intent-Aware Meeting Copilot + Laptop Density Fix

## Meeting copilot
- Added server-side intent classification before retrieval.
- Supports:
  - "What happened in Daily Call with NK"
  - "What should I prepare for tomorrow for Daily Call with NK / NK Sir"
  - "What happened in today’s Daily Call with NK"
  - "What happened in yesterday’s Daily Call with NK"
- Resolves meeting title aliases and date scope before using any transcript/context.
- Enforces a hard meeting boundary: if the query is about a meeting, unrelated meetings/actions/notes are not allowed into the answer.
- Improved source tracing with `v23.4 <intent> strict-thread` labels.

## UI density
- Reduced the always-open Kili/chat panel by roughly 10%.
- Added laptop-specific density correction for 1366px / scaled displays.
- Reduced bloated hero/card/button spacing in the executive brief.
- Tightened sidebar, chat messages, composer and main content padding.

## Compatibility
- Built from v23.3.1 Node 16 install-safe base.
