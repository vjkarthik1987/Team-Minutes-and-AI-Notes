# v13 - GPT-4o-mini Environment Driven Upgrade

## Changes
- Introduced centralized model configuration using:
  OPENAI_MODEL=gpt-4o-mini

- AI summary, action extraction, and thread intelligence now fallback to:
  OPENAI_MODEL

## Benefits
- Easy future model upgrades from `.env`
- No hardcoded model dependency
- Faster experimentation between GPT models

## Example
OPENAI_MODEL=gpt-4o-mini
