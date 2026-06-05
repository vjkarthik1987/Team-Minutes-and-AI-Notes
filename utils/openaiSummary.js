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

async function generateMeetingSummary({ text, subject }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');
  const MAX_CHARS = Number(process.env.SUMMARY_MAX_CHARS || 22000);
  const inputText = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;

  const instructions = `
You are a senior executive assistant creating intelligent meeting memory.
Your job is NOT to write a generic recap. Infer the business context from the transcript and produce a useful, specific, leadership-ready summary.

Non-negotiable rules:
- Use only the transcript. Do not invent facts, people, dates, decisions, or action items.
- Do not say random/generic things like "the team discussed updates" unless you specify what those updates were.
- Capture intent, context, implications, unresolved issues, and next steps.
- If the transcript is thin or mostly greetings, say so clearly.
- No verbatim quotes.
- If owner/due date is unclear, write Unassigned/Unclear.

Output exactly in this structure:

### Intelligent Summary
- 6 to 8 specific bullets covering what was discussed, why it mattered, and the current state.

### Key Outcomes
- Decisions, alignments, or concrete conclusions. If none, write None.

### Action Items
- [Owner: Name/Unassigned] Action — Due: Date/Unclear — Evidence: short non-quoted basis

### Risks / Blockers / Dependencies
- Specific risks, blockers, dependencies, or None.

### Open Questions
- Questions that remain unresolved, or None.

### Executive Readout
- 2 to 3 bullets that a CEO or senior leader would care about.
`;

  const { model, outputText } = await callResponses({
    model: process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    instructions,
    input: `Meeting subject: ${subject || '(unknown)'}\n\nTranscript:\n${inputText}`,
  });
  return { model, summary: outputText };
}

async function generateDetailedMeetingNotes({ text, subject }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty transcript text');
  const MAX_CHARS = Number(process.env.DETAILED_NOTES_MAX_CHARS || 26000);
  const inputText = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
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
  const inputText = trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
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
- If the provided context genuinely lacks enough substance, say what is missing and what to link/load next.
- Do not invent details.

Output for action-item questions:
### Action Items
- [Owner: Name/Unassigned] Action — Due: Date/Unclear — Evidence: short basis

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
  return { model, answer: outputText };
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
      (!m.ai?.summary && !m.ai?.detailedNotes) ? `Transcript excerpt:\n${String(m.text || '').slice(0, 5000)}` : ''
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
