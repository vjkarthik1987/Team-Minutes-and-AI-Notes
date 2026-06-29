// utils/openaiSummary.js
const fetch = require('node-fetch');

function extractOutputText(json) {
  if (json?.output_text && typeof json.output_text === 'string') return json.output_text;
  const out = json?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
      }
    }
  }
  return '';
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function representativeText(text, maxChars) {
  const cleaned = String(text || '').trim();
  const max = Math.max(4000, Number(maxChars || 22000));
  if (cleaned.length <= max) return cleaned;
  const head = Math.floor(max * 0.45);
  const mid = Math.floor(max * 0.25);
  const tail = max - head - mid;
  const midStart = Math.max(0, Math.floor((cleaned.length - mid) / 2));
  return [
    cleaned.slice(0, head),
    '\n\n[Middle of long transcript retained]\n\n' + cleaned.slice(midStart, midStart + mid),
    '\n\n[End of long transcript retained]\n\n' + cleaned.slice(-tail)
  ].join('');
}

function isTransientOpenAIError(status, message) {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status)) || /server had an error|rate limit|timeout|temporarily|overloaded/i.test(String(message || ''));
}
function cleanOpenAIError(message) {
  return String(message || 'OpenAI request failed')
    .replace(/\(Please include the request ID[^)]*\)/gi, '')
    .replace(/request ID req_[a-z0-9]+/gi, 'request ID captured in logs')
    .replace(/\s+/g, ' ')
    .trim();
}

async function callResponses({ model, instructions, input }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const body = { model, instructions, input };
  const maxAttempts = Math.max(1, Number(process.env.OPENAI_MAX_ATTEMPTS || 3));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const message = json?.error?.message || `OpenAI error ${resp.status}`;
        const err = new Error(cleanOpenAIError(message));
        err.status = resp.status;
        err.transient = isTransientOpenAIError(resp.status, message);
        throw err;
      }
      const outputText = extractOutputText(json).trim();
      if (!outputText) throw new Error('OpenAI returned empty output');
      return { model, outputText };
    } catch (e) {
      lastError = e;
      const transient = e.transient || isTransientOpenAIError(e.status, e.message);
      if (!transient || attempt >= maxAttempts) break;
      await sleep(Math.min(8000, 700 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError || new Error('OpenAI request failed');
}


function splitTranscriptForSummary(text, chunkChars) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  const max = Math.max(6000, Number(chunkChars || 12000));
  if (!cleaned) return [];
  if (cleaned.length <= max) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const para of paragraphs.length ? paragraphs : [cleaned]) {
    if ((buf + '\n\n' + para).length <= max) {
      buf = buf ? `${buf}\n\n${para}` : para;
      continue;
    }
    if (buf) chunks.push(buf);
    if (para.length <= max) {
      buf = para;
    } else {
      for (let i = 0; i < para.length; i += max) chunks.push(para.slice(i, i + max));
      buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function generateMeetingSummary({ text, subject, startDateTime, endDateTime, durationMinutes }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');

  const model = process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const explicitMinutes = Number(durationMinutes || 0);
  const derivedMinutes = (startDateTime && endDateTime && Number.isFinite(Date.parse(startDateTime)) && Number.isFinite(Date.parse(endDateTime)))
    ? Math.max(1, Math.round((Date.parse(endDateTime) - Date.parse(startDateTime)) / 60000))
    : 0;
  const meetingMinutes = Math.max(1, Math.round(explicitMinutes || derivedMinutes || Math.max(10, trimmed.split(/\s+/).length / 150)));
  const summaryLineCount = Math.max(2, Math.round(meetingMinutes / 10));
  const chunkChars = Number(process.env.SUMMARY_CHUNK_CHARS || 9500);
  const maxChunks = Math.max(1, Number(process.env.SUMMARY_MAX_CHUNKS || 18));
  let chunks = splitTranscriptForSummary(trimmed, chunkChars);

  // Keep very large calls bounded, but preserve beginning/middle/end rather than only the start.
  if (chunks.length > maxChunks) {
    const headCount = Math.ceil(maxChunks * 0.38);
    const tailCount = Math.ceil(maxChunks * 0.34);
    const midCount = Math.max(0, maxChunks - headCount - tailCount);
    const middleStart = Math.max(headCount, Math.floor((chunks.length - midCount) / 2));
    chunks = [
      ...chunks.slice(0, headCount),
      ...chunks.slice(middleStart, middleStart + midCount),
      ...chunks.slice(-tailCount),
    ];
  }

  const speakerRules = `
Speaker attribution rules:
- Microsoft Teams transcripts can mislabel multiple physical speakers as the signed-in user when people share one login/device.
- Do NOT blindly trust labels like "Karthik V J:" as the actual speaker.
- Infer the likely speaker from nearby dialogue, direct address, self-introduction, role context, and handoff phrases such as "Arun, how do you...", "Peter do you...", "from my side", or "next".
- If a participant is asked by name and the next transcript lines are under a generic or wrong login label, attribute cautiously to the addressed person only when the context is strong.
- If speaker identity is still uncertain, write "the team", "a participant", or "Unassigned" rather than inventing an owner.
- Only write "Karthik said" when the surrounding context clearly shows Karthik personally spoke, not merely that the transcript label says so.
`;

  const teamsStyleTemplate = `
Target output style: practical Microsoft Teams-like notes, but in the simplified Ms. Minutes v27.8 format.

Final output must have exactly these three major parts:
1. Summary
2. Actions
3. Detailed notes

Summary rules:
- Summary must contain exactly ${summaryLineCount} bullets.
- ${summaryLineCount} = round(actual meeting duration in minutes / 10), minimum 2.
- For this meeting, actual duration is ${meetingMinutes} minutes, so Summary must have exactly ${summaryLineCount} bullets.
- Each Summary bullet must say what was discussed at a business/technical level, not a generic headline.

Actions rules:
- Actions must be generous and complete.
- Capture explicit and strong implied tasks: fix, validate, clarify, follow up, check, prepare, send, coordinate, review, discuss separately, confirm, roll out, decide, test, create, update, investigate.
- Do not include owner/person labels in the final visible Actions section.
- Include due date where clear; otherwise Due: Unclear.

Detailed notes rules:
- Detailed notes must be theme-wise like Teams: topic heading ending with a colon, followed by subtopic lines.
- Preserve concrete detail: client/project/module, issue, design point, risk, number, status, dependency, date, owner clue, and impact.
- Do not collapse specific operational issues into vague phrases.
- For a long project/leadership meeting, 6-14 detailed themes are normal if supported.
`;

  const antiPattern = `
Avoid these weak formats completely:
- Intelligent Summary
- Key Outcomes
- Executive Readout
- Meeting notes as the only section
- Follow-up tasks as the only action section
- one short generic bullet per topic
- only two action items when more follow-ups exist
- vague lines such as "the team discussed challenges" without the actual challenge
`;

  const pass1Instructions = `
You are doing PASS 1 of a 3-pass enterprise meeting-notes pipeline.
Your job is extraction, not summarization. Over-extract. Do not compress too early. The final quality depends on you preserving every real discussion theme, not only the most senior-sounding topics.

${speakerRules}

Return markdown exactly in this structure:
### Discussion map
- **Theme:** concrete details from this chunk.
  - **Subtopic:** specific detail with client/product/tool/person/date/number if present.
  - **Subtopic:** specific detail with client/product/tool/person/date/number if present.

### Action ledger
- **Action:** exact next step or implied follow-up. (Due: Date/Unclear; Evidence: short paraphrase; Confidence: High/Medium/Low)

### Risks, blockers, dependencies
- **Risk / blocker / dependency:** what is the concern and why it matters. If none, write: - None clearly stated.

### Decisions and alignments
- **Decision / alignment:** what was agreed or clarified. If none, write: - None clearly stated.

### Speaker and owner clues
- **Person/function:** clues from nearby lines that help resolve who actually spoke or owns the item.

Rules:
- Use only this chunk.
- Capture every explicit and strong implied follow-up, especially around "we will", "I'll", "can we", "please", "by tomorrow", "this week", "next week", "need to", "should", "let us", "take a look", "follow up", "discuss separately", "roll out", "send", "prepare", "review", "validate", "fix", "clarify", "check", "confirm", "coordinate", "appeal", "launch", "pilot", "report next week", "talk to", "work with".
- Treat questions from leaders as possible follow-up tasks when they require someone to investigate, clarify, decide, or report back.
- Preserve business specificity: meeting subject, projects, clients, products, modules, tools, numbers, deadlines, owners, risks, dependencies, operational flows, configuration names, API/pagination issues, validation status, JIRA states, and customer/project impact.
- Do not quote the transcript.
`;

  const chunkNotes = [];
  for (let i = 0; i < chunks.length; i++) {
    const { outputText } = await callResponses({
      model,
      instructions: pass1Instructions,
      input: `Meeting subject: ${subject || '(unknown)'}\nChunk ${i + 1} of ${chunks.length}:\n\n${chunks[i]}`,
    });
    chunkNotes.push(`## Chunk ${i + 1}\n${outputText}`);
  }

  const pass2Instructions = `
You are doing PASS 2 of a 3-pass enterprise meeting-notes pipeline.
Merge the PASS 1 extracts into a complete meeting map. This is still not the final prose.

${speakerRules}

${teamsStyleTemplate}
${antiPattern}

Return markdown exactly in this structure:
### Themes to include in final notes
- **Theme title:** 1 sentence overview.
  - **Subtopic title:** 1-3 sentences with concrete details.
  - **Subtopic title:** 1-3 sentences with concrete details.

### Follow-up task ledger
- **Task title:** specific next step. (Due: Date/Unclear; Evidence: short paraphrase; Confidence: High/Medium/Low)

### Risks / blockers / dependencies ledger
- **Risk title:** specific risk, blocker, or dependency and why it matters.

### Decisions / alignments ledger
- **Decision title:** decision, alignment, or clarification.

### Open questions ledger
- **Question:** what needs clarification or a decision.

Rules:
- Deduplicate repeated points, but never drop unique action items.
- Keep all material themes. For a leadership call or project review, 8-14 themes is normal if supported. For a narrower project meeting, still preserve every distinct issue/workstream rather than collapsing everything into one generic project-risk theme.
- Keep all concrete follow-up tasks. Do not limit to only the top two. Include implied tasks that clearly require follow-up, investigation, correction, coordination, validation, or decision.
- Resolve owners cautiously. If uncertain, use Unassigned.
- Keep short evidence paraphrases only in the task ledger; evidence should not appear in final meeting notes.
- Use only the supplied PASS 1 extracts.
`;

  const { outputText: consolidated } = await callResponses({
    model,
    instructions: pass2Instructions,
    input: `Meeting subject: ${subject || '(unknown)'}\n\nPASS 1 extracts:\n\n${chunkNotes.join('\n\n---\n\n')}`,
  });

  const pass3Instructions = `
You are doing PASS 3 of a 3-pass enterprise meeting-notes pipeline.
Create the final Microsoft Teams-style recap for leadership.

${speakerRules}

${teamsStyleTemplate}
${antiPattern}

Strict output requirements:
- Start exactly with: Generated by AI. Make sure to check for accuracy.
- Then write exactly: Summary:
- Under Summary, write exactly ${summaryLineCount} bullets. No more, no fewer.
- Then write exactly: Actions:
- Under Actions, list all explicit and strong implied follow-ups. Do not reduce to only two.
- Then write exactly: Detailed notes:
- Under Detailed notes, use Teams-like theme headings ending with a colon, followed by indented subtopic lines.
- Do not use markdown H1/H2/H3 headings.
- Do not use the headings Intelligent Summary, Key Outcomes, Action Items, Executive Readout, Meeting notes, Follow-up tasks, Risks / blockers / dependencies, or Open questions as top-level headings.
- Do not include owner/person labels in the visible action text.
- Do not invent facts, owners, deadlines, risks, decisions, or names.
- Do not quote transcript lines.

Final format:
Generated by AI. Make sure to check for accuracy.
Summary:
- Concrete line 1.
- Concrete line 2.

Actions:
- Task title/action. (Due: Date/Unclear)

Detailed notes:
Theme Title:
  Subtopic Title: Concrete 1-3 sentence explanation.
  Subtopic Title: Concrete 1-3 sentence explanation.

Theme Title:
  Subtopic Title: Concrete 1-3 sentence explanation.
`;

  const { outputText: finalSummary } = await callResponses({
    model,
    instructions: pass3Instructions,
    input: `Meeting subject: ${subject || '(unknown)'}
Transcript length: ${trimmed.length} characters
Actual meeting duration: ${meetingMinutes} minutes
Required Summary bullets: ${summaryLineCount}

Consolidated meeting map:

${consolidated}`,
  });

  // v27.7: final Teams-benchmark editor pass. GPT-4o mini is good, but it can
  // still drift back to a thin summary. This pass explicitly compares the draft
  // against the Teams-style target and rewrites for completeness.
  const pass4Instructions = `
You are the final Microsoft Teams-style notes editor.
Your job is to repair the draft so it is much closer to Teams generated notes.

${speakerRules}
${teamsStyleTemplate}
${antiPattern}

Input contains:
1. Consolidated meeting map with themes, ledgers, risks and tasks.
2. Draft summary.

Rewrite the draft using these hard checks:
- Start exactly with: Generated by AI. Make sure to check for accuracy.
- Then: Summary:
- Summary must have exactly ${summaryLineCount} bullets because the meeting duration is ${meetingMinutes} minutes.
- Then: Actions:
- Action capture must be generous. Pull every explicit or strongly implied task from the task ledger.
- If the task ledger has 8 tasks, the final should have about 8 tasks, not 2.
- Then: Detailed notes:
- Use multiple theme headings ending with a colon.
- Under each theme, include named subtopics with concrete details.
- Do not use bullets that only say generic things like "risks were discussed"; say what risk, where, and why it matters.
- Do not include owner/person labels in the visible Actions section because shared-login transcript labels can be misleading.
- Do not invent facts or make unsupported deadlines.
- Do not include Evidence or Confidence fields in the final text.
- Do not include the headings Intelligent Summary, Key Outcomes, Action Items, Executive Readout, Meeting notes, Follow-up tasks, or Leadership readout.

Final shape:
Generated by AI. Make sure to check for accuracy.
Summary:
- Concrete line 1.
- Concrete line 2.

Actions:
- Specific action and expected outcome. (Due: Date/Unclear)

Detailed notes:
Theme Title:
  Subtopic Title: Concrete 1-3 sentence explanation.
  Subtopic Title: Concrete 1-3 sentence explanation.
`;

  const { outputText: polishedSummary } = await callResponses({
    model,
    instructions: pass4Instructions,
    input: `Meeting subject: ${subject || '(unknown)'}
Transcript length: ${trimmed.length} characters
Actual meeting duration: ${meetingMinutes} minutes
Required Summary bullets: ${summaryLineCount}

Consolidated meeting map:
${consolidated}

Draft summary to repair:
${finalSummary}`,
  });

  let summary = String(polishedSummary || finalSummary || '').trim();
  // v27.8 guard rail: force the new three-part summary shape even when the model drifts.
  summary = summary
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\bIntelligent Summary\s*:?/ig, 'Summary:')
    .replace(/\bKey Outcomes\s*:?/ig, 'Detailed notes:')
    .replace(/\bAction Items\s*:?/ig, 'Actions:')
    .replace(/\bFollow-up tasks\s*:?/ig, 'Actions:')
    .replace(/\bMeeting notes\s*:?/ig, 'Detailed notes:')
    .replace(/\bExecutive Readout\s*:?/ig, 'Detailed notes:')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!/^Generated by AI\. Make sure to check for accuracy\./i.test(summary)) {
    summary = `Generated by AI. Make sure to check for accuracy.\n${summary}`;
  }
  if (!/\bSummary\s*:/i.test(summary)) {
    summary = summary.replace(/^Generated by AI\. Make sure to check for accuracy\.\s*/i, 'Generated by AI. Make sure to check for accuracy.\nSummary:\n');
  }
  if (!/\bActions\s*:/i.test(summary)) summary += '\n\nActions:\n- No clear action items captured. (Due: Unclear)';
  summary = stripOwnerLabelsForDisplay(summary);
  if (!/\bDetailed notes\s*:/i.test(summary)) summary += '\n\nDetailed notes:\nNotes: Detailed discussion points were not clearly separated by the model.';

  return { model: `${model} · 3-pass duration summary v27.8`, summary };

}

async function generateDetailedMeetingNotes({ text, subject }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');
  const MAX_CHARS = Number(process.env.DETAILED_NOTES_MAX_CHARS || 26000);
  const inputText = representativeText(trimmed, MAX_CHARS);
  const instructions = `
You are an enterprise meeting-notes assistant. Write detailed, human-readable meeting notes that explain the flow, context, trade-offs, decisions, and next steps.
Use only the transcript. Do not include quotes, timestamps, or invented intent.

Structure exactly:
## Detailed Notes
### Context & Objective
### Current State Overview
### Key Discussion Themes
### Options Considered & Trade-offs
### Decisions & Alignment
### Open Questions & Dependencies
### Next Steps
`;
  const { model, outputText } = await callResponses({
    model: process.env.OPENAI_DETAILED_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Meeting subject: ${subject || '(unknown)'}\n\nTranscript:\n${inputText}`,
  });
  return { model, notes: outputText };
}

function parseJsonArray(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  } catch (_) {
    const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
    }
  }
  return [];
}

async function generateActionItems({ text, subject }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');
  const MAX_CHARS = Number(process.env.ACTION_ITEMS_MAX_CHARS || 22000);
  const inputText = representativeText(trimmed, MAX_CHARS);
  const instructions = `
Extract action items from a meeting transcript.
Return ONLY valid JSON. No markdown. No commentary.

Rules:
- Use only explicit or strongly implied next steps from the transcript.
- Do not create generic actions.
- If no action items exist, return [].
- ownerName should be the named person where clear, otherwise "Unassigned".
- ownerEmail should be empty unless visible in the transcript/context.
- dueDate should be an ISO date if clear, otherwise "Unclear".
- priority must be one of: High, Medium, Low, Unclear.
- confidence is 0 to 1.
- evidence must be a short paraphrase, not a quote.

JSON schema:
[
  {
    "title": "short action title",
    "description": "what needs to be done",
    "ownerName": "Name or Unassigned",
    "ownerEmail": "",
    "dueDate": "YYYY-MM-DD or Unclear",
    "priority": "High|Medium|Low|Unclear",
    "confidence": 0.0,
    "evidence": "short paraphrased basis"
  }
]
`;
  const { model, outputText } = await callResponses({
    model: process.env.OPENAI_ACTION_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Meeting subject: ${subject || '(unknown)'}\n\nTranscript:\n${inputText}`,
  });
  return { model, items: parseJsonArray(outputText) };
}


function stripOwnerLabelsForDisplay(text) {
  let out = String(text || '');
  // Do not expose owner/person labels in AI-visible meeting notes. The user can decide ownership.
  out = out.replace(/\[\s*Owner\s*:\s*[^\]]+\]\s*/gi, '');
  out = out.replace(/\(\s*Owner\s*:\s*[^;\)]+;\s*Due\s*:\s*([^\)]+)\)/gi, '(Due: $1)');
  out = out.replace(/\(\s*Due\s*:\s*([^;\)]+);\s*Owner\s*:\s*[^\)]+\)/gi, '(Due: $1)');
  out = out.replace(/\(\s*Owner\s*:\s*[^\)]+\)/gi, '');
  out = out.replace(/\s+Owner\s*:\s*(Name|Unassigned|[^.;\n]+)\.?\s*/gi, ' ');
  out = out.replace(/—\s*Owner\s*:\s*[^;\n]+;\s*/gi, '— ');
  out = out.replace(/;\s*Owner\s*:\s*[^;\n]+/gi, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\(\s*;\s*/g, '(').replace(/\s+\)/g, ')');
  return out.trim();
}

async function generateMeetingAnswer({ question, context, subject }) {
  const q = String(question || '').trim();
  const ctx = String(context || '').trim();
  if (!q) throw new Error('Empty question');
  if (!ctx) return { model: 'none', answer: 'No transcript context available.' };

  const instructions = `
You answer questions ONLY from the meeting context provided, but write like a sharp Chief of Staff preparing an executive.

Rules:
- Start from the selected/latest meeting shown in the context. Do not drift to older meetings unless they are explicitly included as linked context or the user asks for history/comparison.
- If the question asks for action items, return actual extracted action items first. Do NOT convert them into executive prep unless the user asked for prep.
- If the question asks for follow-up context or prep, produce practical guidance: what to focus on, what to ask, what risks to surface, what decisions/actions need closure.
- Do not produce generic checklist language such as "review technical specs", "validate risks", "confirm outcome is on track", or "close open actions" unless those exact needs are supported by the context.
- Every bullet must include a concrete noun from the meeting: product, client, platform area, issue, person, deliverable, dependency, or decision.
- If the context does not contain actual actions, write "No explicit action items were found in the selected meeting context" and then list unresolved follow-up areas separately.
- Use the latest/directly matched meeting as the anchor, and mention older linked sources only as supporting background.
- If unrelated sources appear in context, ignore them unless they clearly connect to the selected meeting.
- Be useful: summarize actual themes, outcomes, decisions, actions, blockers, implications, and next best discussion points.
- Ignore system/admin activity such as collaborators being added/removed, thread creation, thread settings changes, auto-link messages, imported invite logs, and other UI maintenance unless the user explicitly asks about administration.
- If the provided context genuinely lacks enough substance, say what is missing and what to link/load next.
- Do not invent details.

Output for action-item questions:
### Action Items
- Action — Due: Date/Unclear — Evidence: short basis

### Unresolved Follow-up Areas
- Only if useful; do not invent actions.

Output for prep/follow-up questions:
### Executive Prep
- 3-5 bullets beginning with strong verbs: Focus, Clarify, Push, Confirm, Watch, Decide.

### Follow-up Context
- Specific context from the selected/latest meeting and linked context.

### Questions to Ask
- 3 pointed questions.

### Watch-outs
- Risks/blockers/dependencies or None.

End with: Confidence: High / Medium / Low.
`;
  const { model, outputText } = await callResponses({
    model: process.env.OPENAI_ANSWER_MODEL || process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Meeting: ${subject || 'Untitled'}\n\nContext:\n${ctx}\n\nQuestion:\n${q}`,
  });
  return { model, answer: stripOwnerLabelsForDisplay(outputText) };
}


async function generateChiefOfStaffBrief({ question, context, dateLabel }) {
  const q = String(question || '').trim();
  const ctx = String(context || '').trim();
  if (!ctx) return { model: 'none', answer: 'I do not have enough meeting/action/context evidence to build a Chief-of-Staff brief yet.' };
  const instructions = `
You are a world-class Chief of Staff briefing a CEO before a high-pressure execution day.

This is NOT a meeting recap, NOT minutes, and NOT an action-item dump. It is an executive operating brief.

Rules:
- Use only the evidence supplied. Do not invent facts, people, meetings, risks, dates, or actions.
- Treat scores as prioritization guidance, but still explain the reason in plain executive language.
- Prioritize by executive importance: high-stakes meetings, overdue/urgent actions, silent risks, unresolved decisions, repeating blockers, dependencies, customer/release pressure, and items that need leadership intervention.
- Synthesize across meetings/actions/notes/threads. Do not blindly repeat every item.
- Every recommendation must contain concrete context: meeting name, client/project, person, decision, action, due date, blocker, or risk.
- Explicitly call out silent execution risks when the same blocker/action/thread appears unresolved or stale.
- Avoid generic language like "focus on open actions", "validate risks", "align with stakeholders", "confirm next steps", or "track progress" unless tied to a specific evidence item.
- If there are no strong signals, say that clearly and name what evidence is missing.
- Keep it executive, practical, and direct. Use a Chief-of-Staff tone: crisp, opinionated, grounded.

Output exactly:

### Chief-of-Staff Brief
A 2-3 sentence readout of what deserves attention and why.

### Your Focus Today
1. **Priority title** — why it matters, what you should do as leader, and the specific evidence behind it.
2. **Priority title** — ...
3. **Priority title** — ...
Add up to 5 only if evidence supports it.

### Meetings to Prepare For
- Meeting — precise prep angle based on linked prior context/actions/risks.

### Decisions / Escalations Needed
- Specific decision/escalation, who should be pushed, and why it matters. If none, say None.

### Silent Risks to Watch
- Specific recurring/stale risk/dependency or None.

### Do Not Spend Time On
- Items that look low-signal or can wait, if evidence supports this.

Confidence: High / Medium / Low.
`;
  const { model, outputText } = await callResponses({
    model: process.env.OPENAI_COS_MODEL || process.env.OPENAI_ANSWER_MODEL || process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Date focus: ${dateLabel || 'today'}\n\nUser question: ${q}\n\nEvidence:\n${ctx.slice(0, 30000)}`,
  });
  return { model, answer: outputText };
}


function compactEvidenceLine(value, max = 220) {
  const cleaned = String(value || '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}
function threadHealthLabelFromRating(rating) {
  const r = Math.max(1, Math.min(10, Number(rating || 6)));
  if (r <= 2) return 'Critical';
  if (r <= 4) return 'At Risk';
  if (r <= 6) return 'OK';
  if (r <= 8) return 'Good';
  return 'Strong';
}

function threadConfidenceFromEvidence(meetings, entries) {
  const count = (Array.isArray(meetings) ? meetings.length : 0) + (Array.isArray(entries) ? entries.length : 0);
  if (count >= 6) return 'High';
  if (count >= 2) return 'Medium';
  return 'Low';
}

function cleanThreadSnippet(value) {
  return compactEvidenceLine(String(value || '')
    .replace(/Intelligent Summary\s*-?/ig, '')
    .replace(/\bThe discussion emphasized\b/ig, 'Discussion emphasized')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
  ).replace(/[.…]+$/g, '').trim();
}

function sentenceFromEvidence(snippets, fallback) {
  const s = (snippets || []).map(cleanThreadSnippet).find(x => x && x.length > 25) || '';
  if (!s) return fallback;
  let cleaned = s
    .replace(/Intelligent Summary\s*-?/ig, '')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\bthe discussion emphasized\b/ig, 'the team emphasized')
    .replace(/\bthe meeting primarily focused on\b/ig, 'the team focused on')
    .replace(/\bthe team focused on focused on\b/ig, 'the team focused on')
    .replace(/\.{2,}/g, '.')
    .trim();
  const first = cleaned.split(/(?<=[.!?])\s+/).find(x => x.length > 25) || cleaned;
  return first.slice(0, 280).replace(/[,…]+$/g, '').trim();
}

function stripHealthLine(text) {
  return String(text || '').replace(/\s*Health:\s*(Critical|At Risk|OK|Good|Strong)\s*\(\d{1,2}\s*\/\s*10\)\.??\s*Confidence:\s*(High|Medium|Low)\.??\s*$/i, '').trim();
}

function buildExecutiveNarrative({ meetings, threadName, objective, status, entries }) {
  const list = Array.isArray(meetings) ? meetings : [];
  const entryList = Array.isArray(entries) ? entries : [];
  const risks = entryList.filter(e => e.kind === 'risk' && !/done|closed|resolved/i.test(e.status || ''));
  const actions = entryList.filter(e => e.kind === 'action' && !/done|closed|resolved|dropped/i.test(e.status || ''));
  const gapsText = cleanThreadSnippet((entryList || []).map(e => e.kind === 'risk' || e.kind === 'decision' || e.kind === 'action' ? (e.body || e.title || '') : '').filter(Boolean).join(' '));
  const evidenceSnippets = list.slice(0, 5).map(m => m.ai?.summary || m.ai?.detailedNotes || m.text || '').filter(Boolean);
  const rating = risks.length >= 3 ? 4 : risks.length ? 5 : actions.length >= 4 ? 6 : actions.length ? 7 : 8;
  const label = threadHealthLabelFromRating(rating);
  const confidence = threadConfidenceFromEvidence(list, entryList);
  const initiative = objective || threadName || 'This initiative';
  const material = sentenceFromEvidence(evidenceSnippets, 'The available evidence is still light, so the current read should be treated as an early management view rather than a final judgement');
  const healthPhrase = rating <= 3 ? 'under serious pressure' : rating <= 5 ? 'showing execution risk' : rating === 6 ? 'broadly stable but needing closer follow-through' : rating <= 8 ? 'moving in the right direction' : 'strong and well aligned';
  const riskSentence = risks.length
    ? `There are ${risks.length} visible risk or dependency item(s), so leadership attention should focus on ownership, closure dates and customer impact.`
    : actions.length
      ? `The main management need is follow-through: ${actions.length} open follow-up item(s) should be converted into clear owners, dates and outcomes.`
      : `No explicit risk is captured yet; that should not be read as risk-free. The next discussion should test the weak spots visible in the evidence — scope clarity, accountable owners, milestone dates and whether the work is producing customer-visible progress.`;
  const materialLower = material.charAt(0).toLowerCase() + material.slice(1);
  const para1 = `${initiative} is ${healthPhrase}. Recent meetings indicate that ${materialLower}. The work appears to be moving from discussion into structured follow-through, but it still needs clearer conversion into measurable delivery outcomes.`;
  const para2 = `${riskSentence} For the CEO, the useful question is not whether meetings are happening, but whether the team can point to named owners, dated milestones, specific unresolved gaps and visible release/customer outcomes. Health: ${label} (${rating}/10). Confidence: ${confidence}.`;
  return { narrative: `${para1}\n\n${para2}`, rating, label, confidence };
}

function deterministicThreadProgressSummary({ meetings, threadName, objective, status, entries, reason }) {
  const built = buildExecutiveNarrative({ meetings, threadName, objective, status, entries });
  return {
    model: 'deterministic-executive-narrative',
    progressSummary: built.narrative,
    executiveMemory: built.narrative,
    healthScore: built.rating,
    healthLabel: built.label,
    confidence: built.confidence,
    suggestedStatus: built.rating <= 4 ? 'At Risk' : (status || 'Active')
  };
}

async function generateThreadProgressSummary({ meetings, threadName, objective, desiredOutcome, status, entries }) {
  const list = Array.isArray(meetings) ? meetings : [];
  const entryList = Array.isArray(entries) ? entries : [];
  if (!list.length && !entryList.length) throw new Error('No thread context supplied');
  const MAX_TOTAL = Number(process.env.THREAD_SUMMARY_MAX_CHARS || 28000);
  let ctx = '';
  const header = [
    `Thread: ${threadName || 'Untitled thread'}`,
    objective ? `Objective: ${objective}` : '',
    desiredOutcome ? `Desired outcome: ${desiredOutcome}` : '',
    status ? `Current status: ${status}` : '',
  ].filter(Boolean).join('\n') + '\n\n';
  ctx += header;
  for (const e of entryList.slice(-80)) {
    const block = [`${String(e.kind || '').toUpperCase()}: ${e.title || ''}`,
      e.body || '', Array.isArray(e.checklist) && e.checklist.length ? `Checklist:
${e.checklist.map(c => '- ' + (c.text || c)).join('\n')}` : '', e.ownerEmail ? `Owner: ${e.ownerEmail}` : '', e.dueDate ? `Due: ${e.dueDate}` : '',
      e.status ? `Status: ${e.status}` : '', e.severity ? `Severity: ${e.severity}` : ''
    ].filter(Boolean).join('\n') + '\n\n---\n\n';
    if (ctx.length + block.length > MAX_TOTAL) break;
    ctx += block;
  }
  for (const m of list) {
    const block = [
      `Meeting: ${m.subject || 'Untitled'}`,
      `Date: ${m.startDateTime || 'Unknown'}`,
      m.ai?.summary ? `AI Summary:\n${m.ai.summary}` : '',
      m.ai?.detailedNotes ? `Detailed Notes:\n${m.ai.detailedNotes}` : '',
      (!m.ai?.summary && !m.ai?.detailedNotes) ? `Transcript excerpt:\n${representativeText(m.text || '', 7000)}` : ''
    ].filter(Boolean).join('\n') + '\n\n---\n\n';
    if (ctx.length + block.length > MAX_TOTAL) break;
    ctx += block;
  }
  const instructions = `
You are a Chief of Staff style executive intelligence assistant.
Use only the supplied meetings, AI notes, context, decisions, risks, checklists and actions. Do not invent facts.
Write a CEO-ready narrative, not a meeting-by-meeting digest.

Output exactly two concise but useful paragraphs and nothing else.
Paragraph 1: A CEO-ready narrative of what the initiative is about, where it stands, what materially changed, and why it matters.
Paragraph 2: The management read: whether this is healthy, at risk, or needs attention, what the CEO should ask/decide next, and the clearest next follow-through point. Be specific to the initiative; avoid generic lines about ownership and milestones unless you connect them to concrete evidence.

Rules:
- No markdown headings.
- No bullet lists.
- Do not paste or quote raw meeting summary fragments.
- Never start with phrases like "This thread is to focus", "The latest evidence suggests", or "Based on linked meetings".
- No phrases like Executive Memory, evidence base, deterministic summary, live synthesis unavailable, generic fallback or server error.
- Do not list every meeting separately unless it is essential.
- Be simple, insightful and direct.
- Keep each paragraph around 80-120 words; do not make it too thin.
- End the second paragraph with this exact pattern: Health: <label> (<rating>/10). Confidence: <High|Medium|Low>.
- Rating must be 1-10, where 1-3 is critical, 4-5 is at risk, 6 is OK, 7-8 is good, 9-10 is strong.
`;
  try {
    const { model, outputText } = await callResponses({
      model: process.env.OPENAI_THREAD_MODEL || process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      instructions,
      input: ctx,
    });
    let cleaned = String(outputText || '').replace(/#+\s*/g, '').replace(/\*\*/g, '').trim();
    cleaned = cleaned
      .replace(/(?:Executive Memory|evidence base|deterministic summary|live synthesis unavailable|server error|generic fallback)[^\n]*/ig, '')
      .replace(/Intelligent Summary\s*-?/ig, '')
      .replace(/\s+-\s+/g, ' ')
      .replace(/\.{2,}/g, '.')
      .trim();
    cleaned = cleaned.replace(/\s+\.\./g, '.').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').replace(/\n\s+/g, '\n').trim();
    const ratingMatch = cleaned.match(/Health:\s*([A-Za-z ]+)\s*\((\d{1,2})\s*\/\s*10\)/i) || cleaned.match(/(Critical|At Risk|OK|Good|Strong)\s*\((\d{1,2})\s*\/\s*10\)/i);
    const rating = ratingMatch ? Math.max(1, Math.min(10, Number(ratingMatch[2]))) : 0;
    const healthLabel = ratingMatch ? String(ratingMatch[1]).trim() : (rating ? threadHealthLabelFromRating(rating) : '');
    const confidenceMatch = cleaned.match(/Confidence:\s*(High|Medium|Low)/i);
    const confidence = confidenceMatch ? confidenceMatch[1] : threadConfidenceFromEvidence(list, entryList);
    const suggestedStatus = rating && rating <= 4 ? 'At Risk' : (status || 'Active');
    return { model, progressSummary: cleaned, executiveMemory: cleaned, healthScore: rating, healthLabel, confidence, suggestedStatus };
  } catch (e) {
    if (String(process.env.THREAD_SUMMARY_ALLOW_FALLBACK || 'true').toLowerCase() === 'false') throw e;
    return deterministicThreadProgressSummary({ meetings: list, threadName, objective, status, entries: entryList, reason: e.message || String(e) });
  }
}

module.exports = { generateMeetingSummary, generateDetailedMeetingNotes, generateMeetingAnswer, generateActionItems, generateThreadProgressSummary, deterministicThreadProgressSummary, generateChiefOfStaffBrief };
