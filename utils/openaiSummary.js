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
    Write a crisp, leadership-ready recap for internal sharing.
    NO QUOTES section. Do not include verbatim quotes.

    Rules:
    - Be factual and specific.
    - Use short bullets. Avoid long paragraphs.
    - If something is unclear, write "Unclear".
    - If an owner is not explicit, write "Owner: Unassigned".
    - If no actions exist, write "None".

    Output format (markdown) — follow EXACTLY these headings:

    ### Quick Summary
    - 5 to 6 bullets capturing the essence (outcome + why + impact)

    ### Quick Actions
    - [Owner: Name/Unassigned] Action — Due: Date/Unclear

    ### Decisions
    - bullets (or "None")

    ### Risks / Blockers
    - bullets (or "None")

    ### Notes
    - optional bullets for context (keep concise)
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

async function generateDetailedMeetingNotes({ text, subject }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');

  const MAX_CHARS = 16000; // detailed notes can use a bit more
  const inputText = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;

  const instructions = `
You are an enterprise meeting-notes assistant.

Write DETAILED, HUMAN-READABLE MEETING NOTES.
This is NOT a transcript and must NOT read like one.

Purpose:
- Help someone who missed the meeting fully understand the discussion.
- Provide context, reasoning, and flow.
- The transcript remains the source of truth for exact wording.

Rules:
- Do NOT use quotes.
- Do NOT attribute sentences to speakers.
- Do NOT list timestamps.
- Write in clear, professional paragraphs (not bullet explosion).
- Be factual. If unclear, write "Unclear".
- Do not invent decisions or intent.

Structure your output EXACTLY as follows:

## Detailed Notes

### Context & Objective

### Current State Overview

### Key Discussion Themes

### Options Considered & Trade-offs

### Decisions & Alignment

### Open Questions & Dependencies

### Next Steps (Narrative)
`;

  const body = {
    model: process.env.OPENAI_DETAILED_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
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
  if (!outputText) throw new Error('OpenAI returned empty detailed notes');

  return { model: body.model, notes: outputText };
}

module.exports = { generateMeetingSummary, generateDetailedMeetingNotes };