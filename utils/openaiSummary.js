// utils/openaiSummary.js
const fetch = require('node-fetch');

function extractOutputText(json) {
  // Best case
  if (json?.output_text && typeof json.output_text === 'string') {
    return json.output_text;
  }

  // Your actual payload looks like:
  // output: [{ type:"message", content:[{type:"output_text", text:"..."}], ... }]
  const out = json?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === 'output_text' && typeof c.text === 'string') {
            return c.text;
          }
        }
      }
    }
  }

  return '';
}

async function generateMeetingSummary({ text, subject }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');

  const MAX_CHARS = 12000;
  const inputText = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;

  const instructions = `
You are an enterprise meeting-notes assistant.
Write a crisp, structured summary for internal sharing.

Output format (markdown):
### Summary
- 5 to 7 bullets

### Decisions
- bullets

### Action Items
- bullets (owner unknown), include due date if mentioned

### Risks / Blockers
- bullets

### Key Quotes
1. "..." (optional, max 3)

Be factual. If something is unclear, write "Unclear".
`;

  const body = {
    model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Meeting subject: ${subject || '(unknown)'}\n\nTranscript:\n${inputText}`,
  };

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error?.message || `OpenAI error ${resp.status}`;
    throw new Error(msg);
  }

  const outputText = extractOutputText(json).trim();
  if (!outputText) {
    throw new Error('OpenAI returned empty summary text');
  }

  return { model: body.model, summary: outputText };
}

module.exports = { generateMeetingSummary };
