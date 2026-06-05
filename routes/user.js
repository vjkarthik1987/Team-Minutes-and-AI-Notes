// routes/user.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');


const Org = require('../models/Org');
const EventCache = require('../models/EventCache');
const UserSyncState = require('../models/UserSyncState');
const TranscriptChunk = require('../models/TranscriptChunk');
const ActionItem = require('../models/ActionItem');
const ChatMessage = require('../models/ChatMessage');
const MeetingThread = require('../models/MeetingThread');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const MeetingContext = require('../models/MeetingContext');
const SummaryDigest = require('../models/SummaryDigest');
const ExecutiveBrief = require('../models/ExecutiveBrief');
const ThreadMetric = require('../models/ThreadMetric');
const PersonAlias = require('../models/PersonAlias');
const PersonSignal = require('../models/PersonSignal');
const { buildPeopleDirectory, refreshPersonSignals } = require('../services/peopleIntelligence.service');
const { generateExecutiveBriefForUser, formatBriefAsMarkdown } = require('../services/executiveBrief.service');

const { getUserPrincipals } = require('../utils/acl');
const ensureUserFreshToken = require('../middleware/ensureUserFreshToken');
const { getCalendarRange } = require('../utils/graph');

const { annotateEventsWithTranscripts, getTranscript } = require('../utils/transcripts');
const { chunkByChars, cleanText } = require('../utils/transcriptChunking');
const { sweepOnce } = require('../workers/transcriptSweep.worker');

const Transcript = require('../models/Transcript');
const { vttToText } = require('../utils/vtt');
const { generateMeetingSummary, generateDetailedMeetingNotes, generateMeetingAnswer, generateActionItems, generateThreadProgressSummary, generateChiefOfStaffBrief } = require('../utils/openaiSummary');

async function sendGraphMail(accessToken, { to, subject, body, attachments = [] }) {
  const fetch = require('node-fetch');
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: (to || []).map(address => ({ emailAddress: { address } })),
    attachments: attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType || 'text/plain', contentBytes: Buffer.from(a.content || '', 'utf8').toString('base64') }))
  };
  const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) });
  if (!r.ok) throw new Error(await r.text());
}


const uploadRoot = path.join(__dirname, '..', 'uploads', 'meeting-files');
try { fs.mkdirSync(uploadRoot, { recursive: true }); } catch(e) {}
const meetingFileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(txt|md|pdf|doc|docx|ppt|pptx|png|jpg|jpeg|gif|webp)$/i.test(file.originalname || '');
    if (!okExt) return cb(new Error('Only txt, md, pdf, doc, docx, ppt, pptx and image files are allowed'));
    cb(null, true);
  }
});
function safeReadTextFile(file) {
  try {
    if (!file || !/\.(txt|md)$/i.test(file.originalname || '')) return '';
    return fs.readFileSync(file.path, 'utf8').slice(0, 80000);
  } catch(e) { return ''; }
}
function simplePdfBuffer(title, body) {
  const clean = String(`${title}\n\n${body}` || '').replace(/[()\\]/g, ' ').split(/\r?\n/).slice(0, 60);
  const lines = clean.map((l,i)=>`BT /F1 11 Tf 50 ${760-(i*14)} Td (${l.slice(0,95)}) Tj ET`).join('\n');
  const stream = lines;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`
  ];
  let pdf = '%PDF-1.4\n'; const xref=[0];
  for (const o of objects) { xref.push(Buffer.byteLength(pdf)); pdf += o+'\n'; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${xref.length}\n0000000000 65535 f \n` + xref.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n') + `\ntrailer << /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf);
}

function buildMailFallback({ recipients = [], subject = '', body = '' }) {
  const to = (recipients || []).filter(Boolean).join(';');
  const safeSubject = String(subject || '').slice(0, 180);
  const safeBody = String(body || '').slice(0, 12000);
  const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(safeSubject)}&body=${encodeURIComponent(safeBody)}`;
  const outlookUrl = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(safeSubject)}&body=${encodeURIComponent(safeBody)}`;
  return { mailtoUrl, outlookUrl };
}

function canAssignActions(user) { return user?.role === 'super_admin' || user?.permissions?.canAssignActions || user?.permissions?.canAssignFollowups; }
function canViewAudit(user) { return user?.role === 'super_admin' || user?.permissions?.canViewAuditLog; }
async function writeAudit(req, action, entityType, entityId, summary, metadata = {}) {
  try { await AuditLog.create({ orgId: req.user.org._id, actorUserId: req.user._id, actorEmail: req.user.email, action, entityType, entityId: String(entityId || ''), summary, metadata }); } catch(e) { console.warn('[audit]', e.message || e); }
}
function parseDueDateISO(v) { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d : null; }

function parseNaturalDueDate(text) {
  const raw = String(text || '').trim();
  if (!raw) return { label: '', date: null, unclear: true };
  const q = raw.toLowerCase();
  const now = new Date();
  const add = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(17,0,0,0); return d; };
  const fmt = d => d ? d.toISOString().slice(0,10) : '';
  if (/\btoday\b/.test(q)) { const d = add(0); return { label: fmt(d), date: d }; }
  if (/\btomorrow\b/.test(q)) { const d = add(1); return { label: fmt(d), date: d }; }
  if (/\b(day after tomorrow)\b/.test(q)) { const d = add(2); return { label: fmt(d), date: d }; }
  if (/\bend of (the )?week\b|\beow\b/.test(q)) { const d = new Date(now); const day=d.getDay(); const diff=(5-day+7)%7 || 7; d.setDate(d.getDate()+diff); d.setHours(17,0,0,0); return { label: fmt(d), date: d }; }
  if (/\bnext week\b/.test(q)) { const d = add(7); return { label: fmt(d), date: d }; }
  const inDays = q.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/);
  if (inDays) { const d = add(Number(inDays[1]) * (inDays[2].startsWith('week') ? 7 : 1)); return { label: fmt(d), date: d }; }
  const weekdays = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const wd = q.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) { const target=weekdays[wd[2]]; const d=new Date(now); let diff=(target-d.getDay()+7)%7; if (diff===0 || wd[1]) diff += 7; d.setDate(d.getDate()+diff); d.setHours(17,0,0,0); return { label: fmt(d), date: d }; }
  const dmy = raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](20\d{2}|\d{2}))?\b/);
  if (dmy) { const year = dmy[3] ? (String(dmy[3]).length===2 ? 2000+Number(dmy[3]) : Number(dmy[3])) : now.getFullYear(); const d = new Date(year, Number(dmy[2])-1, Number(dmy[1]), 17,0,0,0); if(Number.isFinite(d.getTime())) return { label: fmt(d), date: d }; }
  const iso = raw.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/);
  if (iso) { const d = new Date(iso[1]); if(Number.isFinite(d.getTime())) return { label: fmt(d), date: d }; }
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime()) && parsed.getFullYear() > 2000) { parsed.setHours(17,0,0,0); return { label: fmt(parsed), date: parsed }; }
  return { label: '', date: null, unclear: true };
}
function nextDueFrom(d, frequency, interval = 1) { const x = d ? new Date(d) : new Date(); const n = Math.max(1, Number(interval)||1); if (frequency==='daily') x.setDate(x.getDate()+n); else if (frequency==='weekly') x.setDate(x.getDate()+(7*n)); else if (frequency==='monthly') x.setMonth(x.getMonth()+n); else return null; return x; }


// v17: conversational command orchestration. Kili should ask the right follow-up
// questions before creating structured objects, rather than guessing silently.
function stripCommandWords(text) {
  return String(text || '')
    .replace(/^(please\s+)?(assign|create|add|make|log|capture)\s+(an?\s+)?/i, '')
    .replace(/^(action\s*item|follow\s*up|todo|note|call\s*note|meeting\s*note)\s*/i, '')
    .trim();
}
function extractQuotedOrAfter(text, markers = []) {
  const raw = String(text || '').trim();
  const quoted = raw.match(/[“\"]([^”\"]{4,220})[”\"]/);
  if (quoted) return quoted[1].trim();
  for (const m of markers) {
    const rx = new RegExp(m + '\\s*[:=-]\\s*(.+)$', 'i');
    const hit = raw.match(rx);
    if (hit) return hit[1].trim();
  }
  return '';
}
function parseChatPeople(text, users = []) {
  const raw = String(text || '');
  const emails = (raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []).map(x => x.toLowerCase());
  const lowered = raw.toLowerCase();
  const byName = [];
  for (const u of users || []) {
    const name = String(u.name || '').trim();
    const email = String(u.email || '').toLowerCase();
    if (!name && !email) continue;
    const parts = name.toLowerCase().split(/\s+/).filter(x => x.length >= 3);
    if ((name && lowered.includes(name.toLowerCase())) || parts.some(part => lowered.includes(part)) || (email && lowered.includes(email))) {
      byName.push({ name: u.name || u.email, email: u.email });
    }
  }
  const map = new Map();
  for (const e of emails) map.set(e, { name: '', email: e });
  for (const u of byName) if (u.email) map.set(String(u.email).toLowerCase(), u);
  return [...map.values()];
}
function parseActionCommand(query, users = [], recentAssistant = '') {
  const q = String(query || '').trim();
  const previousActionFlow = /action item/i.test(recentAssistant || '') && /owner|due date|what should/i.test(recentAssistant || '');
  const isAction = previousActionFlow || /\b(assign|create|add|make|log)\b.*\b(action\s*item|follow\s*up|todo|task)\b/i.test(q) || /^action\s*:/i.test(q);
  if (!isAction) return null;
  let title = extractQuotedOrAfter(q, ['action', 'task', 'title', 'todo']);
  if (!title) {
    const m = q.match(/(?:action\s*item|follow\s*up|todo|task)\s*(?:to|:|-)?\s*(.+?)(?:\s+for\s+[^.]+|\s+to\s+[^.]+|\s+by\s+[^.]+|$)/i);
    title = m ? m[1].trim() : '';
  }
  title = title.replace(/\b(owner|assignee|due)\s*[:=-].*$/i, '').trim();
  if (/^(it|this|that)?$/i.test(title) || title.length < 4) title = '';
  const people = parseChatPeople(q, users);
  let owner = people[0] || null;
  const ownerText = (q.match(/(?:owner|assignee|assigned\s+to|to)\s*[:=-]?\s*([A-Za-z][A-Za-z ._-]{2,60}|[\w.+-]+@[\w.-]+)/i) || [])[1];
  if (ownerText) {
    const key = ownerText.toLowerCase().trim();
    const u = users.find(x => String(x.email||'').toLowerCase() === key || String(x.name||'').toLowerCase().includes(key) || key.includes(String(x.name||'').toLowerCase()));
    owner = u ? { name: u.name || u.email, email: u.email } : { name: ownerText.trim(), email: /@/.test(ownerText) ? ownerText.toLowerCase().trim() : '' };
  }
  const dueHint = (q.match(/(?:due|by|before|on)\s*[:=-]?\s*([^.;]+)$/i) || [])[1] || q;
  const due = parseNaturalDueDate(dueHint);
  const priority = /\b(critical|urgent|high)\b/i.test(q) ? 'High' : (/\b(low)\b/i.test(q) ? 'Low' : 'Medium');
  return { title, owner, due, priority };
}
function parseNoteCommand(query, users = [], recentAssistant = '') {
  const q = String(query || '').trim();
  const previousNoteFlow = /note/i.test(recentAssistant || '') && /what kind|note body|people/i.test(recentAssistant || '');
  const isNote = previousNoteFlow || /\b(create|add|capture|log|make)\b.*\b(note|call|meeting)\b/i.test(q) || /^note\s*:/i.test(q);
  if (!isNote) return null;
  const lower = q.toLowerCase();
  const noteType = /\bcall\b/.test(lower) ? 'call' : (/\bmeeting\b/.test(lower) ? 'manual_meeting' : (/\bremember|memory|remind\b/.test(lower) ? 'personal_note' : 'general'));
  let title = extractQuotedOrAfter(q, ['title', 'subject']);
  if (!title) {
    const m = q.match(/(?:about|regarding|for|on)\s+(.+?)(?:\s+with\s+|\s+people\s*[:=-]|\s+note\s*[:=-]|$)/i);
    title = m ? m[1].trim() : '';
  }
  let body = extractQuotedOrAfter(q, ['note', 'body', 'details']);
  if (!body) body = stripCommandWords(q).replace(/^(note|call|meeting)\s*[:=-]?/i, '').trim();
  if (title && body.toLowerCase().startsWith(title.toLowerCase())) body = body.slice(title.length).trim();
  const people = parseChatPeople(q, users);
  const remindHint = (q.match(/(?:until|till|remind\s+until|keep\s+active\s+until)\s+([^.;]+)$/i) || [])[1] || '';
  const remind = remindHint ? parseNaturalDueDate(remindHint) : { date: null, label: '' };
  return { noteType, title, body, people, remind };
}
function formatPeopleForReply(people = []) {
  return (people || []).map(p => p.name || p.email).filter(Boolean).join(', ') || 'None captured';
}
async function handleChatCommandFlow(req, query) {
  const recent = await ChatMessage.find({ orgId: req.user.org._id, userId: req.user._id }).sort({ createdAt: -1 }).limit(6).lean().catch(()=>[]);
  const lastAssistant = (recent || []).find(m => m.role === 'assistant')?.message || '';
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).lean().catch(()=>[]);

  const action = parseActionCommand(query, users, lastAssistant);
  if (action) {
    const missing = [];
    if (!action.title) missing.push('what exactly the action item is');
    if (!action.owner || (!action.owner.email && !action.owner.name)) missing.push('who owns it');
    if (!action.due || !action.due.date) missing.push('the due date');
    if (missing.length) {
      const reply = [
        'I can assign that action item, but I need a little more before I create it.',
        `Missing: ${missing.join(', ')}.`,
        '',
        'Reply like: Action: finalize hierarchy approach. Owner: Sreejith. Due: tomorrow. Priority: High.'
      ].join('\n');
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
      return { handled: true, answer: reply, sources: [] };
    }
    if (!canAssignActions(req.user)) {
      const reply = 'I understood the action item, but your account does not currently have permission to assign actions. Ask an admin/owner to enable action assignment for you.';
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
      return { handled: true, answer: reply, sources: [] };
    }
    const item = await ActionItem.create({
      orgId: req.user.org._id,
      title: action.title.slice(0,220),
      description: `Created from Kili chat: ${query}`,
      ownerName: action.owner.name || action.owner.email || 'Unassigned',
      ownerEmail: action.owner.email || '',
      assignedByUserId: req.user._id,
      assignedByEmail: req.user.email,
      source: 'manual',
      dueDate: action.due.label || action.due.date.toISOString().slice(0,10),
      dueDateISO: action.due.date,
      priority: action.priority,
      acl: { allowedEmails: uniqEmails([req.user.email, action.owner.email]), updatedAt: new Date() }
    });
    await writeAudit(req, 'CHAT_ACTION_CREATED', 'ActionItem', item._id, `Kili created action ${item.title}`);
    const reply = `Created action item\n\nAction: ${item.title}\nOwner: ${item.ownerName || 'Unassigned'}\nDue: ${item.dueDate || 'Unclear'}\nPriority: ${item.priority || 'Medium'}`;
    await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
    return { handled: true, answer: reply, sources: [] };
  }

  const note = parseNoteCommand(query, users, lastAssistant);
  if (note) {
    const missing = [];
    if (!note.body || note.body.length < 8) missing.push('the note content');
    if ((note.noteType === 'call' || note.noteType === 'manual_meeting') && !note.people.length) missing.push('people involved');
    if (missing.length) {
      const reply = [
        'I can create that note. Tell me the missing details first.',
        `Missing: ${missing.join(', ')}.`,
        '',
        'Reply like: Type: call note. People: Sreejith, Aneesh. Note: discussed hierarchy approach and pending clarification. Link to thread: optional.'
      ].join('\n');
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
      return { handled: true, answer: reply, sources: [] };
    }
    const me = String(req.user.email || '').toLowerCase().trim();
    const sourceType = note.noteType === 'call' ? 'Call note' : note.noteType === 'manual_meeting' ? 'Manual meeting' : note.noteType === 'personal_note' ? 'Personal note' : 'Manual note';
    const ctx = await MeetingContext.create({
      orgId: req.user.org._id,
      contextType: note.noteType,
      sourceType,
      visibility: note.noteType === 'personal_note' ? 'private' : 'thread',
      people: note.people.map(p => p.email || p.name).filter(Boolean),
      occurredAt: new Date(),
      remindUntil: note.remind.date || null,
      noteStatus: 'active',
      addedByUserId: req.user._id,
      addedByEmail: me,
      title: note.title || (note.noteType === 'call' ? 'Call note' : note.noteType === 'manual_meeting' ? 'Manual meeting' : 'Note'),
      contextText: note.body,
      acl: { allowedEmails: uniqEmails([me, ...note.people.map(p=>p.email).filter(Boolean)]), updatedAt: new Date() }
    });
    await writeAudit(req, 'CHAT_NOTE_CREATED', 'MeetingContext', ctx._id, `Kili created ${sourceType}`);
    const reply = `Created ${sourceType.toLowerCase()}\n\nTitle: ${ctx.title}\nPeople: ${formatPeopleForReply(note.people)}\nVisibility: ${ctx.visibility}${ctx.remindUntil ? `\nActive until: ${ctx.remindUntil.toISOString().slice(0,10)}` : ''}`;
    await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
    return { handled: true, answer: reply, sources: [{ subject: ctx.title, startDateTime: String(ctx.createdAt || '') }] };
  }
  return { handled: false };
}
function normalizeThreadTitle(s) { return String(s||'').toLowerCase().replace(/\b(weekly|daily|monthly|recurring|sync|meeting|call|standup|review|discussion|session)\b/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }

function prettyLocalTimeLabel(value) {
  const d = value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function shortPrepText(text, max = 420) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}


function extractMeetingTitleFromQuestion(qRaw) {
  const raw = String(qRaw || '').trim();
  const m = raw.match(/(?:prep(?:aration)?|follow[- ]?up context|follow[- ]?up|context)\s+(?:and\s+prep\s+)?(?:for|on|about)\s+(.+?)(?:\?|$)/i)
    || raw.match(/(?:for|about|on)\s+(.+?)(?:\?|$)/i);
  let title = m && m[1] ? m[1] : '';
  title = title
    .replace(/^the\s+/i, '')
    .replace(/\b(today|tomorrow|please|pls)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title;
}
function subjectOverlapRatio(a, b) {
  const at = normalizeSubjectKey(a).split(/\s+/).filter(x => x.length >= 3);
  const bt = normalizeSubjectKey(b).split(/\s+/).filter(x => x.length >= 3);
  if (!at.length || !bt.length) return 0;
  const bs = new Set(bt);
  let hits = 0;
  for (const t of at) if (bs.has(t) || bt.some(x => x.includes(t) || t.includes(x))) hits++;
  return hits / Math.max(1, at.length);
}
function extractContextSignals(text) {
  const raw = String(text || '').replace(/[#*_`>]/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = raw.split(/(?<=[.!?])\s+|\s+-\s+/).map(x => x.trim()).filter(x => x.length > 35);
  const score = (x) => {
    let n = 0;
    if (/risk|block|delay|unclear|dependency|issue|concern|problem|stuck|pending|gap/i.test(x)) n += 5;
    if (/action|due|owner|next step|finalize|confirm|complete|provide|update|share|close/i.test(x)) n += 4;
    if (/decision|agreed|alignment|decide|sign[- ]?off|approval|scope/i.test(x)) n += 4;
    if (/client|release|delivery|jira|requirement|configuration|design|testing|migration|integration|platform|product|pricing|trade finance|bank guarantee|hierarchy|attribute/i.test(x)) n += 2;
    return n;
  };
  return sentences.sort((a,b)=>score(b)-score(a)).slice(0,5).map(x => x.length > 260 ? x.slice(0,259)+'…' : x);
}
function chiefOfStaffPrepText(item, label) {
  const hasContext = item && item.linkedContextCount;
  if (!hasContext) {
    return `Chief-of-Staff prep for ${item?.subject || label}: No usable context is linked yet. Link the latest relevant meeting/note before relying on AI prep.`;
  }
  const full = String(item.fullPrep || '');
  const signals = extractContextSignals(full);
  const sourceLine = item.previousSubject ? `Anchor on ${item.previousSubject}.` : `Anchor on ${item.linkedContextCount} linked context item(s).`;
  const focus = signals[0] || 'Use the linked context to separate what is decided from what is still pending.';
  const ask = signals[1] || signals[0] || 'Confirm the next concrete owner, date, and decision point.';
  const watch = signals.find(x => /risk|block|delay|unclear|dependency|issue|concern|problem|stuck|pending|gap/i.test(x)) || signals[2] || 'Watch for any unowned dependency before the discussion ends.';
  return [
    `Chief-of-Staff prep for ${item.subject || 'this meeting'}${item.prettyTime ? ' — ' + item.prettyTime : ''}`,
    `- ${sourceLine}`,
    `- Focus on: ${focus}`,
    `- Push/clarify: ${ask}`,
    `- Watch-out: ${watch}`,
    signals[3] ? `- Decision angle: ${signals[3]}` : '',
    '',
    'Evidence to keep open:',
    ...signals.map(x => `- ${x}`)
  ].filter(Boolean).join('\n');
}
function chiefOfStaffDaySummary(items, label) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `No ${label} preparation context yet. Add context meetings or load transcript memory to improve this.`;
  const withCtx = list.filter(x => x.linkedContextCount);
  const noCtx = list.filter(x => !x.linkedContextCount);
  const priority = [...withCtx, ...noCtx].slice(0, 8);
  const lines = [];
  lines.push(`Chief-of-Staff preparation for ${label}`);
  lines.push(withCtx.length ? `Start with the ${withCtx.length} meeting(s) that have linked evidence. Use the exact prior context below; avoid status narration.` : 'No meeting has linked evidence yet; prep is intentionally limited until context is linked.');
  lines.push('');
  priority.forEach((p, idx) => {
    lines.push(`${idx + 1}. ${p.subject}${p.prettyTime ? ' — ' + p.prettyTime : ''}`);
    if (p.linkedContextCount) {
      const signals = extractContextSignals(p.fullPrep || '').slice(0,3);
      if (signals[0]) lines.push(`   - Focus: ${signals[0]}`);
      if (signals[1]) lines.push(`   - Ask/Push: ${signals[1]}`);
      if (signals[2]) lines.push(`   - Watch: ${signals[2]}`);
      if (p.previousSubject) lines.push(`   - Anchor source: ${p.previousSubject}.`);
    } else {
      lines.push('   - No linked context yet: link the latest meeting/note before using this as prep.');
    }
  });
  return lines.join('\n');
}

function actionOwnerScopeForUser(user) {
  const principals = getUserPrincipals(user);
  const name = String(user?.name || '').trim();
  const local = String(user?.email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  const ownerNameBits = [...new Set([name, local, ...name.split(/\s+/), ...local.split(/\s+/)].map(x => String(x || '').trim()).filter(x => x.length >= 3))];
  const ownerNameRegexes = ownerNameBits.map(x => new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  return {
    $or: [
      { ownerEmail: { $in: principals } },
      ...ownerNameRegexes.map(rx => ({ ownerName: rx }))
    ]
  };
}

function pickAssigneeFromText(item, users = [], fallbackAcl = []) {
  const explicitEmail = String(item?.ownerEmail || '').toLowerCase().trim();
  if (explicitEmail) {
    const u = users.find(x => String(x.email || '').toLowerCase() === explicitEmail);
    return { ownerEmail: explicitEmail, ownerName: u?.name || item.ownerName || explicitEmail, confidenceBoost: 0.15 };
  }
  const hay = `${item?.ownerName || ''} ${item?.title || ''} ${item?.description || ''} ${item?.evidence || ''}`.toLowerCase();
  const candidates = users.filter(u => fallbackAcl.includes(String(u.email || '').toLowerCase()) || !fallbackAcl.length);
  let best = null;
  for (const u of candidates) {
    const email = String(u.email || '').toLowerCase().trim();
    const name = String(u.name || '').toLowerCase().trim();
    const parts = name.split(/\s+/).filter(x => x.length >= 3);
    let score = 0;
    if (email && hay.includes(email)) score += 10;
    if (name && hay.includes(name)) score += 8;
    for (const part of parts) if (hay.includes(part)) score += 3;
    if (!best || score > best.score) best = { score, user: u };
  }
  if (best && best.score >= 3) return { ownerEmail: String(best.user.email || '').toLowerCase(), ownerName: best.user.name || best.user.email, confidenceBoost: 0.10 };
  return { ownerEmail: '', ownerName: String(item?.ownerName || '').trim() || 'Unassigned', confidenceBoost: 0 };
}

async function upsertActionItemsForTranscript(doc) {
  if (!doc || !doc._id || !String(doc.text || '').trim()) return { created: 0, skipped: 'empty_transcript' };
  if (!process.env.OPENAI_API_KEY) return { created: 0, skipped: 'missing_openai_key' };

  // v11.2: do not skip a transcript forever just because one older action exists.
  // The bulkWrite below is idempotent by title, so this can safely fill missing
  // owners/due dates from improved extraction without duplicating exact titles.
  const { model, items } = await generateActionItems({
    text: [
      `Meeting: ${doc.subject || ''}`,
      `Date: ${doc.startDateTime || ''}`,
      String(doc.text || '')
    ].join('\n'),
    subject: doc.subject
  });
  const safeItems = (Array.isArray(items) ? items : []).filter(x => String(x?.title || x?.description || '').trim()).slice(0, 30);
  const allowedEmails = Array.isArray(doc.acl?.allowedEmails) ? doc.acl.allowedEmails.map(x => String(x||'').toLowerCase().trim()).filter(Boolean) : [];
  const orgUsers = await User.find({ org: doc.orgId, status: 'active' }).select({ name:1, email:1 }).lean();

  if (!safeItems.length) return { created: 0, model };

  await ActionItem.bulkWrite(safeItems.map(item => {
    const title = String(item.title || item.description || 'Action item').trim().slice(0, 220);
    const inferred = pickAssigneeFromText(item, orgUsers, allowedEmails);
    return {
      updateOne: {
        filter: { orgId: doc.orgId, transcriptDocId: doc._id, title },
        update: {
          $set: {
            orgId: doc.orgId,
            transcriptDocId: doc._id,
            eventId: String(doc.eventId || ''),
            meetingId: String(doc.meetingId || ''),
            transcriptId: String(doc.transcriptId || ''),
            meetingSubject: String(doc.subject || ''),
            meetingStartDateTime: String(doc.startDateTime || ''),
            title,
            description: String(item.description || '').trim(),
            ownerName: inferred.ownerName,
            ownerEmail: inferred.ownerEmail,
            dueDate: (() => { const d = parseNaturalDueDate(`${item.dueDate || ''} ${item.evidence || ''} ${item.title || ''}`); return d.label || ''; })(),
            dueDateISO: (() => { const d = parseNaturalDueDate(`${item.dueDate || ''} ${item.evidence || ''} ${item.title || ''}`); return d.date; })(),
            priority: ['Low', 'Medium', 'High', 'Unclear'].includes(item.priority) ? item.priority : 'Unclear',
            confidence: Math.max(0, Math.min(1, Number(item.confidence || 0) + inferred.confidenceBoost)),
            evidence: String(item.evidence || '').trim(),
            acl: { allowedEmails: [...new Set([...allowedEmails, inferred.ownerEmail].filter(Boolean))], updatedAt: new Date() },
            generatedByModel: model,
            generatedAt: new Date(),
          },
          $setOnInsert: { status: 'Open', createdAt: new Date() },
        },
        upsert: true,
      }
    };
  }), { ordered: false });
  return { created: safeItems.length, model };
}


async function upsertActionItemsForTranscriptOnce(doc, userId) {
  if (!doc || !doc._id) return { created: 0, skipped: 'missing_doc' };
  const locked = await Transcript.findOneAndUpdate(
    {
      _id: doc._id,
      $or: [
        { 'processingLock.actionItemsGeneratedAt': null },
        { 'processingLock.actionItemsGeneratedAt': { $exists: false } },
      ],
    },
    { $set: { 'processingLock.actionItemsGeneratedAt': new Date(), 'processingLock.actionItemsGeneratedBy': userId || null } },
    { new: true }
  );
  if (!locked) return { created: 0, skipped: 'already_generated_for_this_transcript' };
  const result = await upsertActionItemsForTranscript(locked);
  await Transcript.updateOne({ _id: doc._id }, { $set: { 'processingLock.actionItemsModel': result?.model || process.env.OPENAI_MODEL || '' } });
  return result;
}

async function getOrCreateSharedTranscriptForEvent(orgId, ev, principals = []) {
  const refs = ev?.transcripts || [];
  const ids = refs.map(r => r.transcriptDocId).filter(Boolean);
  if (ids.length) {
    const byRef = await Transcript.findOne({ orgId, _id: { $in: ids } }).sort({ createdAt: -1 });
    if (byRef && hasTranscriptPayload(byRef)) return byRef;
  }
  const byEvent = await Transcript.findOne({ orgId, eventId: ev.eventId, $or: [{ 'acl.allowedEmails': { $in: principals } }, { participantEmails: { $in: principals } }] }).sort({ startDateTime:-1, createdAt:-1 });
  if (byEvent && hasTranscriptPayload(byEvent)) return byEvent;
  const bySaved = await findSavedTranscriptForEvent(orgId, ev);
  if (bySaved && hasTranscriptPayload(bySaved)) return await Transcript.findById(bySaved._id);
  return null;
}

async function ensureTranscriptChunksForDoc(doc) {
  if (!doc || !doc._id) return { created: false, count: 0 };
  const exists = await TranscriptChunk.findOne({ transcriptDocId: doc._id }).select({ _id: 1 }).lean();
  if (exists) return { created: false, count: 0 };
  const text = cleanText(doc.text || '');
  if (!text) return { created: false, count: 0 };
  const parts = chunkByChars(text, Number(process.env.CHAT_CHUNK_CHARS || 3600), Number(process.env.CHAT_CHUNK_OVERLAP || 500));
  if (!parts.length) return { created: false, count: 0 };
  await TranscriptChunk.bulkWrite(parts.map(p => ({
    updateOne: {
      filter: { orgId: doc.orgId, transcriptDocId: doc._id, chunkIndex: p.chunkIndex },
      update: {
        $set: {
          orgId: doc.orgId,
          transcriptDocId: doc._id,
          eventId: String(doc.eventId || ''),
          meetingId: String(doc.meetingId || ''),
          transcriptId: String(doc.transcriptId || ''),
          subject: String(doc.subject || ''),
          startDateTime: String(doc.startDateTime || ''),
          chunkIndex: p.chunkIndex,
          text: p.text,
          charStart: p.charStart,
          charEnd: p.charEnd,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      upsert: true,
    }
  })), { ordered: false });
  return { created: true, count: parts.length };
}

// helper windows
function past30DaysIncludingToday() {
  const now = new Date();

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setDate(now.getDate() - 29);
  start.setHours(0, 0, 0, 0);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function next3DaysIncludingTomorrow() {
  const now = new Date();

  const start = new Date(now);
  start.setDate(now.getDate() + 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 2);
  end.setHours(23, 59, 59, 999);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

async function getEventParticipants(accessToken, eventId) {
  if (!eventId) return [];

  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id,organizer,attendees`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }

  if (!r.ok) return [];

  const emails = [];
  const orgEmail = j?.organizer?.emailAddress?.address;
  if (orgEmail) emails.push(orgEmail);

  const atts = Array.isArray(j?.attendees) ? j.attendees : [];
  for (const a of atts) {
    const em = a?.emailAddress?.address;
    if (em) emails.push(em);
  }

  return [...new Set(emails.map(e => String(e).toLowerCase().trim()).filter(Boolean))];
}

// "karthikvj@suntecsbs.com" vs "karthikvj@suntecgroup.com"
function sameMailbox(a, b) {
  if (!a || !b) return false;
  const A = String(a).toLowerCase().trim();
  const B = String(b).toLowerCase().trim();
  if (A === B) return true;
  return A.split('@')[0] === B.split('@')[0];
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function clampDate(d) {
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return null;
  return x;
}

// Merge overlapping/adjacent ranges to avoid repeated Graph calls
function mergeRanges(ranges) {
  const clean = ranges
    .map(r => ({ start: clampDate(r.start), end: clampDate(r.end) }))
    .filter(r => r.start && r.end && r.start <= r.end)
    .sort((a, b) => a.start - b.start);

  if (!clean.length) return [];

  const out = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const prev = out[out.length - 1];
    const cur = clean[i];

    // if overlapping or adjacent (within 1 minute), merge
    if (cur.start.getTime() <= prev.end.getTime() + 60 * 1000) {
      prev.end = new Date(Math.max(prev.end.getTime(), cur.end.getTime()));
    } else {
      out.push(cur);
    }
  }
  return out;
}

async function upsertTranscriptEventsToCache({
  accessToken,
  orgId,
  userEmail,
  rangeStart,
  rangeEnd,
  annotateEventsWithTranscripts,
  getCalendarRange,
  maxChecks = 80,
  concurrency = 4,
}) {
  // 1) Fetch events metadata
  const list = await getCalendarRange(accessToken, {
    startDateTime: rangeStart.toISOString(),
    endDateTime: rangeEnd.toISOString(),
    top: 75,
    max: 300,
  });

  const events = Array.isArray(list) ? list : [];

  // 2) Candidates: online meetings only
  const candidates = events.filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));

  // 3) Annotate transcript existence (expensive)
  const annotated = await annotateEventsWithTranscripts(accessToken, candidates, {
    maxChecks,
    concurrency,
  });

  const transcriptEvents = (annotated || []);
  const eventsToCache = transcriptEvents;

  // 4) Upsert into EventCache (only transcript events)
  if (eventsToCache.length) {
    const bulk = EventCache.collection.initializeUnorderedBulkOp();
    let ops = 0;

    for (const ev of eventsToCache) {
      const emails = [];

      const orgEmail = ev.organizer?.emailAddress?.address;
      if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());

      const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
      for (const a of atts) {
        const em = a?.emailAddress?.address;
        if (em) emails.push(String(em).toLowerCase().trim());
      }

      const payload = await buildCachePayloadWithTranscriptAwareness(orgId, userEmail, ev);

      bulk
        .find({ orgId, userEmail, eventId: payload.eventId })
        .upsert()
        .updateOne({
          $set: payload,
          $setOnInsert: { createdAt: new Date() },
        });

      ops++;
    }

    if (ops > 0) await bulk.execute();
  }

  return { transcriptEventsCount: transcriptEvents.length };
}



// GET /user/login
router.get('/login', (req, res) => {
  res.render('user/login', { title: 'User login' });
});

// POST /user/login
// v23.1: no tenant/workspace slug is collected from users.
// Org is resolved after Microsoft sign-in using the email domain.
router.post('/login', async (req, res, next) => {
  try {
    delete req.session.joinOrgId;
    req.session.save((err) => {
      if (err) return next(err);
      return res.redirect('/auth/office365');
    });
  } catch (e) {
    next(e);
  }
});

// User homepage (protected)
function requireUser(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email && req.user?.org) return next();
  return res.redirect('/user/login');
}

function toIsoZ(graphDateTime) {
  // graphDateTime can be:
  // - string "2026-01-13T10:00:00.0000000" (no zone)
  // - or object { dateTime, timeZone }
  const dt = typeof graphDateTime === 'string'
    ? graphDateTime
    : (graphDateTime?.dateTime || '');

  if (!dt) return '';

  const s = String(dt).trim();

  // already has timezone info
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return s;

  // If you requested UTC via Prefer, Graph gives UTC "floating" time -> append Z
  return `${s}Z`;
}


function normalizeSubjectKey(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\b(cancelled|canceled|updated|fw|fwd|re)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function eventStartMs(ev) {
  const raw = ev?.startDateTime || toIsoZ(ev?.start) || ev?.start?.dateTime || '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
async function findSavedTranscriptForEvent(orgId, ev) {
  const eventId = String(ev?.eventId || ev?.id || '').trim();
  const subject = String(ev?.subject || '').trim();
  const startMs = eventStartMs(ev);
  if (eventId) {
    const byEvent = await Transcript.findOne({ orgId, eventId })
      .select({ _id: 1, meetingId: 1, transcriptId: 1, subject: 1, startDateTime: 1, text: 1, vtt: 1, 'ai.summary': 1 })
      .lean();
    if (hasTranscriptPayload(byEvent)) return byEvent;
  }
  if (!subject || !startMs) return null;
  const subjectKey = normalizeSubjectKey(subject);
  const candidates = await Transcript.find({ orgId, subject: { $regex: subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })
    .select({ _id: 1, meetingId: 1, transcriptId: 1, subject: 1, startDateTime: 1, text: 1, vtt: 1, 'ai.summary': 1 })
    .sort({ startDateTime: -1 })
    .limit(20)
    .lean();
  let best = null;
  let bestDiff = Infinity;
  for (const t of candidates) {
    const tk = normalizeSubjectKey(t.subject);
    if (!tk || (!tk.includes(subjectKey) && !subjectKey.includes(tk))) continue;
    const ts = Date.parse(t.startDateTime || '');
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - startMs);
    if (diff < bestDiff && diff <= 6 * 60 * 60 * 1000) { best = t; bestDiff = diff; }
  }
  return best;
}
function transcriptRefFromDoc(doc) {
  if (!doc) return null;
  return { transcriptDocId: String(doc._id || ''), meetingId: String(doc.meetingId || ''), transcriptId: String(doc.transcriptId || '') };
}
function hasTranscriptPayload(doc) {
  return !!(doc && String(doc.text || doc.vtt || doc.ai?.summary || doc.ai?.detailedNotes || doc.transcriptId || '').trim());
}
async function annotateAiIndexStatuses(orgId, events) {
  const list = events || [];
  if (!list.length) return list;
  const ids = [...new Set(list.flatMap(ev => (ev.transcripts || []).map(t => String(t.transcriptDocId || '')).filter(Boolean)))];
  const byId = new Map();
  if (ids.length) {
    const docs = await Transcript.find({ orgId, _id: { $in: ids } }).select({ _id:1, aiIndexStatus:1, aiIndexedAt:1 }).lean().catch(()=>[]);
    const chunks = await TranscriptChunk.aggregate([
      { $match: { orgId: new mongoose.Types.ObjectId(String(orgId)), transcriptDocId: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: '$transcriptDocId', count: { $sum: 1 }, last: { $max: '$updatedAt' } } }
    ]).catch(()=>[]);
    for (const d of docs) byId.set(String(d._id), { status: d.aiIndexStatus || 'not_loaded', at: d.aiIndexedAt || null, chunkCount: 0 });
    for (const c of chunks) {
      const key = String(c._id);
      const prev = byId.get(key) || {};
      byId.set(key, { ...prev, status: c.count > 0 ? 'indexed' : (prev.status || 'not_loaded'), at: prev.at || c.last || null, chunkCount: c.count });
    }
  }
  return list.map(ev => {
    const refs = ev.transcripts || [];
    const first = refs.map(r => byId.get(String(r.transcriptDocId || ''))).find(Boolean);
    return { ...ev, aiIndexStatus: ev.hasTranscript ? (first?.status || 'not_loaded') : 'not_loaded', aiIndexedAt: first?.at || null, aiChunkCount: first?.chunkCount || 0 };
  });
}
async function loadAiContextForEvent(req, eventId) {
  const orgId = req.user.org._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const principals = getUserPrincipals(req.user);
  const ev = await EventCache.findOne({ orgId, userEmail: me, eventId });
  if (!ev) throw new Error('Meeting not found in your calendar cache');
  await EventCache.updateOne({ _id: ev._id }, { $set: { aiIndexStatus: 'processing', aiIndexError: '' } });
  let doc = await getOrCreateSharedTranscriptForEvent(orgId, ev, principals);
  if (!doc || !hasTranscriptPayload(doc)) {
    await EventCache.updateOne({ _id: ev._id }, { $set: { aiIndexStatus: 'failed', aiIndexError: 'No saved transcript found for this meeting' } });
    throw new Error('No saved transcript found for this meeting. Open/link the transcript first.');
  }
  const allowed = new Set([me, ...(ev.attendeeEmails || []), ev.organizerEmail, ...(doc.acl?.allowedEmails || []), ...(doc.participantEmails || [])].map(x => String(x||'').toLowerCase()).filter(Boolean));
  await Transcript.updateOne({ _id: doc._id }, { $set: { acl: { allowedEmails: Array.from(allowed), updatedAt: new Date() }, aiIndexStatus: 'processing', aiIndexError: '' } });
  doc = await Transcript.findById(doc._id);
  await ensureTranscriptChunksForDoc(doc);
  try { await upsertActionItemsForTranscriptOnce(doc, req.user._id); } catch(e) { console.warn('[load-ai-context] action extraction failed:', e.message || String(e)); }
  await Transcript.updateOne({ _id: doc._id }, { $set: { aiIndexStatus: 'indexed', aiIndexedAt: new Date(), aiIndexError: '' } });
  const ref = transcriptRefFromDoc(doc);
  await EventCache.updateOne({ _id: ev._id }, { $set: { hasTranscript: true, aiIndexStatus: 'indexed', aiIndexedAt: new Date(), aiIndexError: '' }, $addToSet: { transcripts: ref } });
  return doc;
}
async function hydrateCachedTranscriptFlags(orgId, events) {
  const list = events || [];
  if (!list.length) return [];

  // v11.2 performance fix: old version did one Transcript query per event.
  // This bulk lookup keeps Calendar opening fast while still preserving old transcript links.
  const eventIds = [...new Set(list.map(ev => String(ev?.eventId || ev?.id || '').trim()).filter(Boolean))];
  const byEvent = new Map();
  if (eventIds.length) {
    const docs = await Transcript.find({ orgId, eventId: { $in: eventIds } })
      .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, text:1, vtt:1, 'ai.summary':1 })
      .lean();
    for (const d of docs) {
      if (hasTranscriptPayload(d)) byEvent.set(String(d.eventId), d);
    }
  }

  const needFuzzy = list.filter(ev => !(ev.hasTranscript && Array.isArray(ev.transcripts) && ev.transcripts.length) && !byEvent.has(String(ev.eventId || ev.id || '')));
  const minStart = needFuzzy.reduce((m, ev) => Math.min(m, eventStartMs(ev) || Infinity), Infinity);
  const maxStart = needFuzzy.reduce((m, ev) => Math.max(m, eventStartMs(ev) || 0), 0);
  let fuzzyDocs = [];
  if (needFuzzy.length && Number.isFinite(minStart) && maxStart) {
    const start = new Date(minStart - 6 * 60 * 60 * 1000).toISOString();
    const end = new Date(maxStart + 6 * 60 * 60 * 1000).toISOString();
    fuzzyDocs = await Transcript.find({ orgId, startDateTime: { $gte: start, $lte: end } })
      .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, text:1, vtt:1, 'ai.summary':1 })
      .sort({ startDateTime:-1 })
      .limit(500)
      .lean();
  }

  const updates = [];
  const out = list.map(ev => {
    if (ev.hasTranscript && Array.isArray(ev.transcripts) && ev.transcripts.length) return ev;
    const eid = String(ev?.eventId || ev?.id || '').trim();
    let saved = eid ? byEvent.get(eid) : null;
    if (!saved) {
      const subjectKey = normalizeSubjectKey(ev.subject);
      const startMs = eventStartMs(ev);
      if (subjectKey && startMs) {
        let best = null; let bestDiff = Infinity;
        for (const t of fuzzyDocs) {
          const tk = normalizeSubjectKey(t.subject);
          if (!tk || (!tk.includes(subjectKey) && !subjectKey.includes(tk))) continue;
          const ts = Date.parse(t.startDateTime || '');
          if (!Number.isFinite(ts)) continue;
          const diff = Math.abs(ts - startMs);
          if (diff < bestDiff && diff <= 6 * 60 * 60 * 1000) { best = t; bestDiff = diff; }
        }
        saved = best;
      }
    }
    if (!saved) return ev;
    const ref = transcriptRefFromDoc(saved);
    const patched = { ...ev, hasTranscript: true, transcripts: ref ? [ref] : (ev.transcripts || []) };
    if (ev._id) updates.push({ updateOne: { filter: { _id: ev._id }, update: ref ? { $set: { hasTranscript: true }, $addToSet: { transcripts: ref } } : { $set: { hasTranscript: true } } } });
    return patched;
  });
  if (updates.length) EventCache.bulkWrite(updates, { ordered:false }).catch(()=>{});
  return out;
}
async function buildCachePayloadWithTranscriptAwareness(orgId, userEmail, ev) {
  const eventId = String(ev.id || ev.eventId || '');
  const orgEmail = ev.organizer?.emailAddress?.address || ev.organizerEmail || '';
  const emails = [];
  if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());
  const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
  for (const a of atts) {
    const em = a?.emailAddress?.address || a;
    if (em) emails.push(String(em).toLowerCase().trim());
  }
  const uniqEmails = [...new Set(emails.filter(Boolean))];
  const graphRefs = (ev._transcripts || []).map(t => ({ meetingId: String(t.meetingId || ''), transcriptId: String(t.id || t.transcriptId || '') })).filter(t => t.meetingId || t.transcriptId);
  const existing = eventId ? await EventCache.findOne({ orgId, userEmail, eventId }).select({ hasTranscript:1, transcripts:1, linkedThreadId:1, linkedThreadName:1, aiIndexStatus:1 }).lean() : null;
  const saved = await findSavedTranscriptForEvent(orgId, ev);
  const savedRef = transcriptRefFromDoc(saved);
  const refs = graphRefs.length ? graphRefs : (savedRef ? [savedRef] : (existing?.transcripts || []));
  const hasTranscript = !!(graphRefs.length || savedRef || existing?.hasTranscript || (refs && refs.length));
  return {
    orgId,
    userEmail,
    eventId,
    subject: ev.subject || '',
    startDateTime: toIsoZ(ev.start || ev.startDateTime),
    endDateTime: toIsoZ(ev.end || ev.endDateTime),
    location: ev.location?.displayName || ev.location || '',
    organizerEmail: String(orgEmail || '').toLowerCase().trim(),
    attendeeEmails: uniqEmails,
    hasTranscript,
    aiIndexStatus: hasTranscript ? (existing?.aiIndexStatus || 'not_loaded') : 'not_loaded',
    transcripts: refs,
    syncedAt: new Date(),
  };
}


function contextSnippet(c) {
  return String(c?.contextText || c?.fileText || '').replace(/\s+/g, ' ').trim().slice(0, 900);
}
function buildMeetingPrepItem(meeting, linkedContexts, precedingDoc) {
  const contextBlocks = (linkedContexts || []).map((c, i) => {
    const body = contextSnippet(c);
    return `${i + 1}. ${c.title || c.sourceType || 'Context'}${c.sourceType ? ' · ' + c.sourceType : ''}${c.createdAt ? ' · ' + prettyLocalTimeLabel(c.createdAt) : ''}\n${body || 'No note text captured.'}`;
  }).join('\n\n');
  const prevSummary = precedingDoc?.ai?.summary || precedingDoc?.ai?.detailedNotes || '';
  const parts = [];
  if (contextBlocks) parts.push(`Linked context added by people:\n${contextBlocks}`);
  if (prevSummary) parts.push(`Previous linked meeting: ${precedingDoc.subject || 'Meeting'}${precedingDoc.startDateTime ? ' — ' + prettyLocalTimeLabel(precedingDoc.startDateTime) : ''}\n${shortPrepText(prevSummary, 1800)}`);
  const full = parts.length ? parts.join('\n\n---\n\n') : 'No preparation context yet. Add a context meeting/note or load transcript memory to improve this.';
  return {
    subject: meeting.subject || 'Meeting',
    eventId: meeting.eventId || '',
    startDateTime: meeting.startDateTime || '',
    prettyTime: prettyLocalTimeLabel(meeting.startDateTime),
    linkedContextCount: (linkedContexts || []).length + (precedingDoc ? 1 : 0),
    linkedContexts: (linkedContexts || []).map(c => ({ title: c.title || c.sourceType || 'Context', sourceType: c.sourceType || c.contextType || 'Context', createdAt: c.createdAt || '', preview: contextSnippet(c).slice(0, 180) })),
    previousCount: precedingDoc ? 1 : 0,
    previousSubject: precedingDoc?.subject || '',
    fullPrep: full,
    prep: shortPrepText(full, 320),
  };
}


router.get('/home', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const executiveBrief = await generateExecutiveBriefForUser({ user: req.user, force: String(req.query.regenerate || '') === '1' });
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const yesterdayStart = startOfDay(addDays(now, -1));
  const yesterdayEnd = endOfDay(addDays(now, -1));
  const tomorrowStart = startOfDay(addDays(now, 1));
  // On Fridays, the Tomorrow tab is a weekend bridge and shows meetings through Monday.
  const tomorrowWindowEnd = endOfDay(addDays(now, now.getDay() === 5 ? 3 : 1));
  const baseFilter = { orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase() };

  const yesterdayMeetings = await EventCache.find({ ...baseFilter, startDateTime: { $gte: yesterdayStart.toISOString(), $lte: yesterdayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(24).lean();
  const todayMeetings = await EventCache.find({ ...baseFilter, startDateTime: { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(24).lean();
  const tomorrowMeetings = await EventCache.find({ ...baseFilter, startDateTime: { $gte: tomorrowStart.toISOString(), $lte: tomorrowWindowEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(36).lean();
  const mondayMeetings = [];

  const recentTranscripts = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .sort({ startDateTime:-1 })
    .limit(160)
    .lean();
  const contextMeetingOptions = recentTranscripts.map(t => ({ _id: t._id, subject: t.subject || 'Meeting', startDateTime: t.startDateTime || '', prettyTime: prettyLocalTimeLabel(t.startDateTime), searchLabel: `${t.subject || 'Meeting'} — ${prettyLocalTimeLabel(t.startDateTime) || t.startDateTime || ''}` }));

  const allMeetings = [...yesterdayMeetings, ...todayMeetings, ...tomorrowMeetings];
  const eventIds = [...new Set(allMeetings.map(m => String(m.eventId || '')).filter(Boolean))];
  const linkedContexts = eventIds.length ? await MeetingContext.find({ orgId: req.user.org._id, eventId: { $in: eventIds }, $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean() : [];
  const contextsByEvent = new Map();
  for (const c of linkedContexts) {
    const k = String(c.eventId || '');
    if (!contextsByEvent.has(k)) contextsByEvent.set(k, []);
    contextsByEvent.get(k).push(c);
  }

  const precedingIds = [...new Set(allMeetings.map(m => String(m.precedingTranscriptDocId || '')).filter(Boolean))];
  const precedingDocs = precedingIds.length ? await Transcript.find({ _id: { $in: precedingIds }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .lean() : [];
  const precedingById = new Map(precedingDocs.map(d => [String(d._id), d]));

  const decorateMeeting = (m, label) => {
    const ctxs = contextsByEvent.get(String(m.eventId || '')) || [];
    const prevDoc = m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null;
    return { ...m, _label: label, linkedContextCount: ctxs.length + (prevDoc ? 1 : 0), linkedContexts: ctxs.map(c => ({ title: c.title || c.sourceType || 'Context', sourceType: c.sourceType || c.contextType || 'Context', createdAt: c.createdAt || '', preview: contextSnippet(c).slice(0, 180) })), precedingContext: prevDoc ? { title: prevDoc.subject || 'Previous meeting', sourceType: 'Teams meeting', createdAt: prevDoc.startDateTime || '', preview: shortPrepText(prevDoc.ai?.summary || prevDoc.ai?.detailedNotes || '', 180) } : null };
  };
  const yesterdayMeetingCards = yesterdayMeetings.map(m => decorateMeeting(m, 'Yesterday'));
  const todayMeetingCards = todayMeetings.map(m => decorateMeeting(m, 'Today'));
  const tomorrowMeetingCards = tomorrowMeetings.map(m => decorateMeeting(m, now.getDay() === 5 ? 'Tomorrow → Monday' : 'Tomorrow'));
  const combinedMeetings = [...yesterdayMeetingCards, ...todayMeetingCards, ...tomorrowMeetingCards];

  const prepItemsToday = todayMeetings.map(m => buildMeetingPrepItem(m, contextsByEvent.get(String(m.eventId || '')) || [], m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null));
  const prepItemsTomorrow = tomorrowMeetings.map(m => buildMeetingPrepItem(m, contextsByEvent.get(String(m.eventId || '')) || [], m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null));
  const prepItems = prepItemsToday;

  const pendingActions = await ActionItem.find({ orgId: req.user.org._id, status: { $nin: ['Done','Dropped'] }, ...actionOwnerScopeForUser(req.user) }).sort({ dueDateISO:1, createdAt:-1 }).limit(12).lean();
  const todayActionItems = pendingActions.filter(a => {
    if (!a.dueDateISO) return String(a.dueDate || '').toLowerCase().includes('today');
    const d = new Date(a.dueDateISO);
    return d >= todayStart && d <= todayEnd;
  });
  const closedSince = startOfDay(addDays(new Date(), -7));
  const closedActions = await ActionItem.find({ orgId: req.user.org._id, status: 'Done', updatedAt: { $gte: closedSince }, ...actionOwnerScopeForUser(req.user) }).sort({ updatedAt:-1 }).limit(8).lean();
  const overdueActions = pendingActions.filter(a => a.dueDateISO && new Date(a.dueDateISO).getTime() < Date.now());
  const notificationStats = { assigned: pendingActions.length, overdue: overdueActions.length, closed: closedActions.length, overdueActions, closedActions };

  const hasLoadedTranscriptMemory = await EventCache.exists({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), aiIndexStatus: 'indexed' });
  const isFirstLogin = !hasLoadedTranscriptMemory && (!!req.session.isFirstUserLogin || Number(req.user.loginCount || 0) <= 1);
  delete req.session.isFirstUserLogin;

  const todaysPrepSummary = chiefOfStaffDaySummary(prepItemsToday, 'today');
  const tomorrowsPrepSummary = chiefOfStaffDaySummary(prepItemsTomorrow, 'tomorrow');
  prepItemsToday.forEach(p => { p.cosPrep = chiefOfStaffPrepText(p, 'today'); });
  prepItemsTomorrow.forEach(p => { p.cosPrep = chiefOfStaffPrepText(p, 'tomorrow'); });

  const userEmail = String(req.user.email || '').toLowerCase();
  const userThreads = await MeetingThread.find({
    orgId: req.user.org._id,
    deletedAt: null,
    $or: [
      { createdBy: req.user._id },
      { ownerEmail: userEmail },
      { contributorEmails: { $in: principals } },
      { viewerEmails: { $in: principals } },
      { memberEmails: { $in: principals } },
      { 'acl.allowedEmails': { $in: principals } }
    ]
  })
    .select({ name:1, objective:1, desiredOutcome:1, status:1, priority:1, ownerEmail:1, memberEmails:1, meetingIds:1, entries:1, updatedAt:1, createdAt:1, keyDecisionsNeeded:1, keyGaps:1, keyQuestions:1, 'ai.progressSummary':1, 'ai.executiveMemory':1, 'ai.insight':1, 'ai.healthScore':1, 'ai.healthLabel':1, 'ai.confidence':1, 'dailyDigest.attentionToday':1 })
    .sort({ updatedAt: -1 })
    .limit(80)
    .lean();

  res.render('user/home', {
    title: 'Meeting Memory', activeNav: 'home', user: req.user, org: req.user.org,
    yesterdayMeetings, todayMeetings, tomorrowMeetings, mondayMeetings, combinedMeetings,
    yesterdayMeetingCards, todayMeetingCards, tomorrowMeetingCards, userThreads,
    tomorrowTabLabel: now.getDay() === 5 ? 'Tomorrow → Monday' : 'Tomorrow',
    contextCards: todayMeetingCards.map(m => ({ meeting: m, previous: [] })),
    pendingActions, todayActionItems, notificationStats,
    prepItems, prepItemsToday, prepItemsTomorrow,
    isFirstLogin, contextMeetingOptions, todaysPrepSummary, tomorrowsPrepSummary, executiveBrief
  });
});


// v23: Day Command separates today/tomorrow/preparation/actions from the executive home brief.
router.get('/day-command', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const executiveBrief = await generateExecutiveBriefForUser({ user: req.user, force: String(req.query.regenerate || '') === '1' });
  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
  const tomorrowStart = startOfDay(addDays(new Date(), 1));
  const tomorrowEnd = endOfDay(addDays(new Date(), 1));
  const mondayOffset = new Date().getDay() === 5 ? 3 : 1;
  const mondayStart = startOfDay(addDays(new Date(), mondayOffset));
  const mondayEnd = endOfDay(addDays(new Date(), mondayOffset));
  const baseFilter = { orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase() };

  const todayMeetings = await EventCache.find({ ...baseFilter, startDateTime: { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(16).lean();
  const tomorrowMeetings = await EventCache.find({ ...baseFilter, startDateTime: { $gte: tomorrowStart.toISOString(), $lte: tomorrowEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(16).lean();
  const mondayMeetings = new Date().getDay() === 5 ? await EventCache.find({ ...baseFilter, startDateTime: { $gte: mondayStart.toISOString(), $lte: mondayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(16).lean() : [];

  const recentTranscripts = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .sort({ startDateTime:-1 })
    .limit(160)
    .lean();
  const contextMeetingOptions = recentTranscripts.map(t => ({ _id: t._id, subject: t.subject || 'Meeting', startDateTime: t.startDateTime || '', prettyTime: prettyLocalTimeLabel(t.startDateTime), searchLabel: `${t.subject || 'Meeting'} — ${prettyLocalTimeLabel(t.startDateTime) || t.startDateTime || ''}` }));

  const allMeetings = [...todayMeetings, ...tomorrowMeetings];
  const eventIds = [...new Set(allMeetings.map(m => String(m.eventId || '')).filter(Boolean))];
  const linkedContexts = eventIds.length ? await MeetingContext.find({ orgId: req.user.org._id, eventId: { $in: eventIds }, $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean() : [];
  const contextsByEvent = new Map();
  for (const c of linkedContexts) {
    const k = String(c.eventId || '');
    if (!contextsByEvent.has(k)) contextsByEvent.set(k, []);
    contextsByEvent.get(k).push(c);
  }

  const precedingIds = [...new Set(allMeetings.map(m => String(m.precedingTranscriptDocId || '')).filter(Boolean))];
  const precedingDocs = precedingIds.length ? await Transcript.find({ _id: { $in: precedingIds }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .lean() : [];
  const precedingById = new Map(precedingDocs.map(d => [String(d._id), d]));

  const decorateMeeting = (m, label) => {
    const ctxs = contextsByEvent.get(String(m.eventId || '')) || [];
    const prevDoc = m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null;
    return { ...m, _label: label, linkedContextCount: ctxs.length + (prevDoc ? 1 : 0), linkedContexts: ctxs.map(c => ({ title: c.title || c.sourceType || 'Context', sourceType: c.sourceType || c.contextType || 'Context', createdAt: c.createdAt || '', preview: contextSnippet(c).slice(0, 180) })), precedingContext: prevDoc ? { title: prevDoc.subject || 'Previous meeting', sourceType: 'Teams meeting', createdAt: prevDoc.startDateTime || '', preview: shortPrepText(prevDoc.ai?.summary || prevDoc.ai?.detailedNotes || '', 180) } : null };
  };
  const todayMeetingCards = todayMeetings.map(m => decorateMeeting(m, 'Today'));
  const tomorrowMeetingCards = tomorrowMeetings.map(m => decorateMeeting(m, 'Tomorrow'));
  const combinedMeetings = [...todayMeetingCards, ...tomorrowMeetingCards];

  const prepItemsToday = todayMeetings.map(m => buildMeetingPrepItem(m, contextsByEvent.get(String(m.eventId || '')) || [], m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null));
  const prepItemsTomorrow = tomorrowMeetings.map(m => buildMeetingPrepItem(m, contextsByEvent.get(String(m.eventId || '')) || [], m.precedingTranscriptDocId ? precedingById.get(String(m.precedingTranscriptDocId)) : null));
  const prepItems = prepItemsToday;

  const pendingActions = await ActionItem.find({ orgId: req.user.org._id, status: { $nin: ['Done','Dropped'] }, ...actionOwnerScopeForUser(req.user) }).sort({ dueDateISO:1, createdAt:-1 }).limit(12).lean();
  const todayActionItems = pendingActions.filter(a => {
    if (!a.dueDateISO) return String(a.dueDate || '').toLowerCase().includes('today');
    const d = new Date(a.dueDateISO);
    return d >= todayStart && d <= todayEnd;
  });
  const closedSince = startOfDay(addDays(new Date(), -7));
  const closedActions = await ActionItem.find({ orgId: req.user.org._id, status: 'Done', updatedAt: { $gte: closedSince }, ...actionOwnerScopeForUser(req.user) }).sort({ updatedAt:-1 }).limit(8).lean();
  const overdueActions = pendingActions.filter(a => a.dueDateISO && new Date(a.dueDateISO).getTime() < Date.now());
  const notificationStats = { assigned: pendingActions.length, overdue: overdueActions.length, closed: closedActions.length, overdueActions, closedActions };

  const hasLoadedTranscriptMemory = await EventCache.exists({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), aiIndexStatus: 'indexed' });
  const isFirstLogin = !hasLoadedTranscriptMemory && (!!req.session.isFirstUserLogin || Number(req.user.loginCount || 0) <= 1);
  delete req.session.isFirstUserLogin;

  const todaysPrepSummary = chiefOfStaffDaySummary(prepItemsToday, 'today');
  const tomorrowsPrepSummary = chiefOfStaffDaySummary(prepItemsTomorrow, 'tomorrow');
  prepItemsToday.forEach(p => { p.cosPrep = chiefOfStaffPrepText(p, 'today'); });
  prepItemsTomorrow.forEach(p => { p.cosPrep = chiefOfStaffPrepText(p, 'tomorrow'); });

  res.render('user/day_command', {
    title: 'Day Command', activeNav: 'day-command', user: req.user, org: req.user.org,
    todayMeetings, tomorrowMeetings, mondayMeetings, combinedMeetings,
    contextCards: todayMeetingCards.map(m => ({ meeting: m, previous: [] })),
    pendingActions, todayActionItems, notificationStats,
    prepItems, prepItemsToday, prepItemsTomorrow,
    isFirstLogin, contextMeetingOptions, todaysPrepSummary, tomorrowsPrepSummary, executiveBrief
  });
});


router.get('/transparency', requireUser, async (req, res) => {
  res.render('user/transparency', {
    title: 'AI & Technology Transparency',
    activeNav: 'transparency',
    user: req.user,
    org: req.user.org,
    modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    summaryModel: process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    actionModel: process.env.OPENAI_ACTION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    threadModel: process.env.OPENAI_THREAD_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  });
});

router.get('/calendar', requireUser, ensureUserFreshToken, async (req, res) => {
  let error = null;

  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();

  const PAST_DAYS = Math.max(1, Number(req.query.pastDays || 30));
  const doRefresh = String(req.query.refresh || '') === '1';

  // tokens only needed when we refresh
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  // window boundaries
  const now = new Date();
  const pastStart = new Date(now);
  pastStart.setDate(now.getDate() - (PAST_DAYS - 1));
  pastStart.setHours(0, 0, 0, 0);

  const pastEnd = new Date(now);
  pastEnd.setHours(23, 59, 59, 999);
  const futureStart = new Date(now);
  futureStart.setHours(0, 0, 0, 0);
  const futureEnd = new Date(now);
  futureEnd.setDate(now.getDate() + 5);
  futureEnd.setHours(23, 59, 59, 999);

  try {
    // --------------------------
    // 0) ALWAYS read cache first
    // --------------------------
    let cachedAll = await EventCache.find({
      orgId,
      userEmail: me,
    })
      .sort({ startDateTime: -1 })
      .limit(500)
      .lean();
    cachedAll = await hydrateCachedTranscriptFlags(orgId, cachedAll);
    cachedAll = await annotateAiIndexStatuses(orgId, cachedAll);
    cachedAll = await annotateAiIndexStatuses(orgId, cachedAll);

    const prevEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
    });
    const futureEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t > pastEnd.getTime() && t <= futureEnd.getTime();
    }).sort((a,b)=>Date.parse(a.startDateTime||0)-Date.parse(b.startDateTime||0));

    const lastCached = await EventCache.findOne({ orgId, userEmail: me })
      .sort({ syncedAt: -1 })
      .select({ syncedAt: 1 })
      .lean();
    const savedTranscripts = await Transcript.find({ orgId, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } })
      .select({ _id: 1, subject: 1, startDateTime: 1 })
      .sort({ startDateTime: -1 })
      .limit(150)
      .lean();

    // ---------------------------------------------------------
    // 1) If NOT refresh => render immediately (instant open)
    // ---------------------------------------------------------
    if (!doRefresh) {
      return res.render('user/calendar', {
        title: 'Calendar',
        user: req.user,
        org: req.user.org,
        activeNav: 'calendar',
        prevEvents: prevEventsFromCache.filter(e => e.hasTranscript),
        allEvents: prevEventsFromCache,
        futureEvents: futureEventsFromCache,
        savedTranscripts,
        contextMeetingOptions: savedTranscripts,
        threads: await MeetingThread.find({ orgId, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).select({ _id:1,name:1 }).sort({ name:1 }).lean(),
        error: null,
        pastDays: PAST_DAYS,
        lastSyncedAt: lastCached?.syncedAt || null,
        isRefreshing: false, // UI hint
        ragError: req.query.ragError || '',
        indexed: req.query.indexed || '',
      });
    }

    // ---------------------------------------------------------
    // 2) Refresh requested => call Graph + update cache
    // ---------------------------------------------------------
    if (!accessToken) {
      error = 'No access token available. Please sign in again.';
      return res.render('user/calendar', {
        title: 'Calendar',
        user: req.user,
        org: req.user.org,
        activeNav: 'calendar',
        prevEvents: prevEventsFromCache.filter(e => e.hasTranscript),
        allEvents: prevEventsFromCache,
        futureEvents: futureEventsFromCache,
        savedTranscripts,
        contextMeetingOptions: savedTranscripts,
        threads: await MeetingThread.find({ orgId, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).select({ _id:1,name:1 }).sort({ name:1 }).lean(),
        error,
        pastDays: PAST_DAYS,
        lastSyncedAt: lastCached?.syncedAt || null,
        isRefreshing: false,
        ragError: req.query.ragError || '',
        indexed: req.query.indexed || '',
      });
    }

    // Fetch events (metadata)
    const pastList = await getCalendarRange(accessToken, {
      startDateTime: pastStart.toISOString(),
      endDateTime: pastEnd.toISOString(),
      top: 75,
      max: 300,
    });

    const futureList = await getCalendarRange(accessToken, {
      startDateTime: futureStart.toISOString(),
      endDateTime: futureEnd.toISOString(),
      top: 75,
      max: 200,
    });

    const events = Array.isArray(pastList) ? pastList : [];
    const futureEvents = Array.isArray(futureList) ? futureList : [];

    // Only online candidates
    const candidates = events.filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));

    // Check transcript existence only for candidates
    const annotated = await annotateEventsWithTranscripts(accessToken, candidates, {
      maxChecks: 60,
      concurrency: 4,
    });

    const transcriptEvents = (annotated || []);
  const eventsToCache = transcriptEvents;

    // Bulk upsert cache
    if (eventsToCache.length) {
      const bulk = EventCache.collection.initializeUnorderedBulkOp();
      let ops = 0;

      for (const ev of eventsToCache) {
        const emails = [];

        const orgEmail = ev.organizer?.emailAddress?.address;
        if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());

        const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
        for (const a of atts) {
          const em = a?.emailAddress?.address;
          if (em) emails.push(String(em).toLowerCase().trim());
        }

        const payload = await buildCachePayloadWithTranscriptAwareness(orgId, me, ev);

        bulk.find({ orgId, userEmail: me, eventId: payload.eventId }).upsert().updateOne({
          $set: payload,
          $setOnInsert: { createdAt: new Date() },
        });

        ops++;
      }

      if (ops > 0) await bulk.execute();
    }

    // ✅ After refresh, redirect to cache-only view (fast)
    return res.redirect(`/user/calendar?pastDays=${encodeURIComponent(PAST_DAYS)}`);
  } catch (e) {
    error = e.message || String(e);
    if (/InvalidAuthenticationToken|Lifetime validation failed|token is expired/i.test(error)) {
      req.session.userTokens = null;
      error = 'Your Microsoft calendar session expired. Please sign in/connect Microsoft again, then refresh calendar.';
    }
    // even on error, still show cached results
    let cachedAll = await EventCache.find({
      orgId,
      userEmail: me,
    })
      .sort({ startDateTime: -1 })
      .limit(500)
      .lean();
    cachedAll = await hydrateCachedTranscriptFlags(orgId, cachedAll);

    const prevEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
    });
    const futureEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t > pastEnd.getTime() && t <= futureEnd.getTime();
    }).sort((a,b)=>Date.parse(a.startDateTime||0)-Date.parse(b.startDateTime||0));

    const lastCached = await EventCache.findOne({ orgId, userEmail: me })
      .sort({ syncedAt: -1 })
      .select({ syncedAt: 1 })
      .lean();
    const savedTranscripts = await Transcript.find({ orgId, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } })
      .select({ _id: 1, subject: 1, startDateTime: 1 })
      .sort({ startDateTime: -1 })
      .limit(150)
      .lean();

    return res.render('user/calendar', {
      title: 'Calendar',
      user: req.user,
      org: req.user.org,
      activeNav: 'calendar',
      prevEvents: prevEventsFromCache.filter(e => e.hasTranscript),
        allEvents: prevEventsFromCache,
      futureEvents: futureEventsFromCache || [],
      savedTranscripts,
      contextMeetingOptions: savedTranscripts,
      threads: await MeetingThread.find({ orgId, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).select({ _id:1,name:1 }).sort({ name:1 }).lean(),
      error,
      pastDays: PAST_DAYS,
      lastSyncedAt: lastCached?.syncedAt || null,
      isRefreshing: false,
      ragError: req.query.ragError || '',
      indexed: req.query.indexed || '',
      syncedFrom: null,
      syncedTo: null,
      lastBackfillAt: null,
    });
  }
});

// POST /user/chat  (placeholder - we'll wire real bot next)
// router.post('/chat', requireUser, express.json(), async (req, res) => {
//   const msg = String(req.body?.message || '').trim();

//   if (!msg) return res.json({ reply: 'Please type a message.' });

//   // Placeholder response until we connect meeting-aware RAG
//   return res.json({
//     reply: `Got it. (Chatbot wiring next)\n\nYou asked: "${msg}"\n\nNext: I’ll answer from your meeting transcripts + summaries.`,
//   });
// });

router.get('/debug/transcript/:eventId', requireUser, ensureUserFreshToken, async (req, res) => {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  if (!accessToken) return res.status(401).send('No access token.');

  const eventId = req.params.eventId;

  try {
    const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id,subject,start,end,onlineMeeting,onlineMeetingUrl,isOnlineMeeting`;
    const ev = await (await require('node-fetch')(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })).json();

    const joinUrl = ev?.onlineMeeting?.joinUrl || ev?.onlineMeetingUrl || null;

    return res.json({
      eventId,
      subject: ev?.subject,
      start: ev?.start?.dateTime,
      end: ev?.end?.dateTime,
      joinUrl,
      isOnlineMeeting: ev?.isOnlineMeeting,
      onlineMeetingObj: ev?.onlineMeeting || null
    });
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// GET /user/transcript/ensure/:meetingId/:transcriptId
router.get(
  '/transcript/ensure/:meetingId/:transcriptId',
  requireUser,
  ensureUserFreshToken,
  async (req, res) => {

    const tokens = res.locals.userTokens;
    const accessToken = (tokens?.access_token || '').trim();
    if (!accessToken) return res.status(401).send('No access token.');

    const { meetingId, transcriptId } = req.params;
    const eventId = String(req.query.eventId || '').trim();
    const orgId = req.user.org?._id;

    const me = String(req.user.email || '').toLowerCase().trim();

    let doc = null;

    try {
      // ✅ MIGRATION-SAFE LOOKUP:
      // New key: (orgId, eventId, transcriptId)
      // Old key: (orgId, meetingId, transcriptId)
      doc = await Transcript.findOne({ orgId, eventId, transcriptId });
      if (!doc) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });

      // Create if missing
      if (!doc) {
        const vtt = await getTranscript(accessToken, meetingId, transcriptId, 'text/vtt');
        const text = vttToText(vtt);

        // Fetch participants for enrichment (not hard-auth gate)
        const participantEmails = await getEventParticipants(accessToken, eventId);

        // Optional log for alias mismatch
        if (participantEmails.length && !participantEmails.some(p => sameMailbox(p, me))) {
          console.warn('[transcript-access] email not in attendee list (alias likely):', me, participantEmails);
        }

        try {
          doc = await Transcript.create({
            orgId,
            eventId,
            meetingId,
            transcriptId,
            subject: req.query.subject || '',
            startDateTime: req.query.start || '',
            endDateTime: req.query.end || '',
            participantEmails,
            vtt,
            text,
            ai: { status: 'none' },
          });
        } catch (e) {
          if (e.code === 11000) {
            doc = await Transcript.findOne({ orgId, eventId, transcriptId });
            if (!doc) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
          } else {
            throw e;
          }
        }
      }

      // Hard guard
      if (!doc) {
        return res.status(500).send('Transcript document could not be created or loaded.');
      }

      // Backfill participants if missing
      if (!doc.participantEmails || !doc.participantEmails.length) {
        const participantEmails = await getEventParticipants(accessToken, eventId);
        if (participantEmails.length) {
          await Transcript.updateOne({ _id: doc._id }, { $set: { participantEmails } });
          doc.participantEmails = participantEmails;
        }
      }

      // ✅ Access check:
      // We DO NOT hard-block based on attendee list because of alias/UPN mismatches.
      // If you want to hard-block later, do it by verifying /me identity (mail/proxyAddresses).
      const allowed = (doc.participantEmails || []).some(p => sameMailbox(p, me));
      if (doc.participantEmails?.length && !allowed) {
        console.warn('[transcript-access] mismatch; allowing via calendar visibility:', me, doc.participantEmails);
      }

      await ensureTranscriptChunksForDoc(doc);

      // If summary already done
      if (doc.ai?.status === 'done' && doc.ai?.summary) {
        try {
        const freshForActions = await Transcript.findById(doc._id);
        await upsertActionItemsForTranscript(freshForActions);
      } catch (actionErr) {
        console.warn('[actions] generation failed:', actionErr.message || String(actionErr));
      }

      return res.redirect(`/user/transcript/saved/${doc._id}`);
      }

      // Reset stale queued
      const now = Date.now();
      const queuedAt = doc.ai?.updatedAt ? new Date(doc.ai.updatedAt).getTime() : 0;
      const QUEUE_STALE_MS = 5 * 60 * 1000;

      if (doc.ai?.status === 'queued' && queuedAt && (now - queuedAt) > QUEUE_STALE_MS) {
        await Transcript.updateOne(
          { _id: doc._id },
          { $set: { 'ai.status': 'none', 'ai.error': 'stale queued reset', 'ai.updatedAt': new Date() } }
        );
        doc = await Transcript.findById(doc._id);
      }

      // ----------------------
// ✅ Generate Detailed Notes (separate from transcript)
// ----------------------
if (!doc.ai?.detailedNotes && (doc.ai?.detailedStatus === 'none' || doc.ai?.detailedStatus === 'error')) {

  // Acquire lock for detailed notes
  await Transcript.updateOne(
    {
      _id: doc._id,
      $or: [
        { 'ai.detailedStatus': { $in: ['none', 'error'] } },
        { 'ai.detailedStatus': { $exists: false } },
      ],
    },
    { $set: { 'ai.detailedStatus': 'queued', 'ai.detailedUpdatedAt': new Date() } }
  );

  doc = await Transcript.findById(doc._id);

  if (doc.ai?.detailedStatus === 'queued' && !doc.ai?.detailedNotes) {
    try {
      console.log('AI detailed notes generating:', String(doc._id), 'len:', (doc.text || '').length);

      const { model, notes } = await generateDetailedMeetingNotes({
        text: doc.text || '',
        subject: doc.subject || req.query.subject || '',
      });

      await Transcript.updateOne(
        { _id: doc._id },
        {
          $set: {
            'ai.detailedStatus': 'done',
            'ai.detailedModel': model,
            'ai.detailedNotes': notes,
            'ai.detailedError': '',
            'ai.detailedCreatedAt': doc.ai?.detailedCreatedAt || new Date(),
            'ai.detailedUpdatedAt': new Date(),
          },
        }
      );
    } catch (err) {
      console.log('AI detailed notes failed:', err);

      await Transcript.updateOne(
        { _id: doc._id },
        {
          $set: {
            'ai.detailedStatus': 'error',
            'ai.detailedError': err.message || String(err),
            'ai.detailedUpdatedAt': new Date(),
          },
        }
      );
    }
  }

  doc = await Transcript.findById(doc._id);
}


      // Acquire lock
      await Transcript.updateOne(
        {
          _id: doc._id,
          $or: [
            { 'ai.status': { $in: ['none', 'error'] } },
            { 'ai.status': { $exists: false } },
          ],
        },
        { $set: { 'ai.status': 'queued', 'ai.updatedAt': new Date() } }
      );

      doc = await Transcript.findById(doc._id);

      // Generate summary
      if (doc.ai?.status === 'queued' && !doc.ai?.summary) {
        try {
          console.log('AI summary generating:', String(doc._id), 'len:', (doc.text || '').length);

          const { model, summary } = await generateMeetingSummary({
            text: doc.text || '',
            subject: doc.subject || req.query.subject || '',
          });

          await Transcript.updateOne(
            { _id: doc._id },
            {
              $set: {
                'ai.status': 'done',
                'ai.model': model,
                'ai.summary': summary,
                'ai.error': '',
                'ai.createdAt': doc.ai?.createdAt || new Date(),
                'ai.updatedAt': new Date(),
              },
            }
          );
        } catch (err) {
          console.log('AI summary failed:', err);

          await Transcript.updateOne(
            { _id: doc._id },
            {
              $set: {
                'ai.status': 'error',
                'ai.error': err.message || String(err),
                'ai.updatedAt': new Date(),
              },
            }
          );
        }
      }

      try {
        const freshForActions = await Transcript.findById(doc._id);
        await upsertActionItemsForTranscript(freshForActions);
      } catch (actionErr) {
        console.warn('[actions] generation failed:', actionErr.message || String(actionErr));
      }

      return res.redirect(`/user/transcript/saved/${doc._id}`);
    } catch (e) {
      return res.status(500).send(e.message || String(e));
    }
  }
);

router.get('/transcript/saved/:id', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');

  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');

  return res.render('user/transcript_saved', {
    title: 'Saved Transcript',
    user: req.user,
    org: req.user.org,
    doc,
  });
});

router.get('/transcript/saved/:id/summary', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');
  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');

  return res.render('user/summary', {
    title: 'AI Summary',
    user: req.user,
    org: req.user.org,
    doc,
  });
});

router.get('/transcript/saved/:id/notes', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');
  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');

  return res.render('user/detailed_notes', {
    title: 'Detailed Notes',
    user: req.user,
    org: req.user.org,
    doc,
  });
});



router.post('/actions/refresh', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const docs = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals }, text: { $exists: true, $ne: '' } })
    .sort({ startDateTime:-1, createdAt:-1 })
    .limit(50);
  let refreshed = 0; let failed = 0;
  for (const doc of docs) {
    try { await upsertActionItemsForTranscript(doc); refreshed++; }
    catch(e) { failed++; console.warn('[actions/refresh]', doc.subject, e.message || String(e)); }
  }
  req.session.flash = `Action refresh complete: ${refreshed} meeting(s) checked${failed ? `, ${failed} failed` : ''}.`;
  return res.redirect('/user/actions');
});

router.post('/actions/refresh-meeting/:id', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const doc = await Transcript.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!doc) return res.status(404).send('Transcript not found');
  try { await upsertActionItemsForTranscript(doc); }
  catch(e) { console.warn('[actions/refresh-meeting]', e.message || String(e)); }
  return res.redirect('/user/actions');
});

router.get('/actions/new', requireUser, async (req, res) => {
  if (!canAssignActions(req.user)) return res.status(403).send('You do not have permission to assign action items.');
  const principals = getUserPrincipals(req.user);
  const assignableUsers = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).sort({ name:1,email:1 }).lean();
  const meetings = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1 }).sort({ startDateTime:-1 }).limit(150).lean();
  res.render('user/action_new', { title: 'New Action Item', activeNav: 'actions', user: req.user, org: req.user.org, assignableUsers, meetings });
});

router.get('/actions', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const status = String(req.query.status || '').trim();
  const filter = {
    orgId: req.user.org._id,
    'acl.allowedEmails': { $in: principals },
  };
  if (status) filter.status = status;
  const actions = await ActionItem.find(filter).sort({ status: 1, meetingStartDateTime: -1, createdAt: -1 }).lean();
  const threads = await MeetingThread.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, name:1, meetingIds:1 }).lean();
  const threadByMeeting = new Map();
  for (const t of threads) {
    for (const mid of (t.meetingIds || [])) threadByMeeting.set(String(mid), { id: String(t._id), name: t.name });
  }
  const groupedActionsMap = new Map();
  for (const a of actions) {
    const meetingKey = a.transcriptDocId ? String(a.transcriptDocId) : (a.eventId || 'unlinked');
    const th = a.transcriptDocId ? threadByMeeting.get(String(a.transcriptDocId)) : null;
    const groupKey = `${th?.id || 'no-thread'}::${meetingKey}`;
    if (!groupedActionsMap.has(groupKey)) groupedActionsMap.set(groupKey, {
      key: groupKey,
      threadName: th?.name || 'Not connected to a thread',
      meetingSubject: a.meetingSubject || (a.transcriptDocId ? 'Meeting' : 'Unlinked action items'),
      meetingStartDateTime: a.meetingStartDateTime || '',
      transcriptDocId: a.transcriptDocId ? String(a.transcriptDocId) : '',
      actions: [],
    });
    groupedActionsMap.get(groupKey).actions.push(a);
  }
  const groupedActions = Array.from(groupedActionsMap.values());
  const nowMs = Date.now();
  const digest = { overdue: 0, stale: 0, waiting: 0, escalated: 0, recurring: 0 };
  for (const a of actions) {
    if (a.dueDateISO && new Date(a.dueDateISO).getTime() < nowMs && !['Done','Dropped'].includes(a.status)) digest.overdue += 1;
    if (a.updatedAt && nowMs - new Date(a.updatedAt).getTime() > 5*24*60*60*1000 && !['Done','Dropped'].includes(a.status)) digest.stale += 1;
    if (a.status === 'Waiting') digest.waiting += 1;
    if (a.escalated) digest.escalated += 1;
    if (a.recurrence && a.recurrence.enabled) digest.recurring += 1;
  }
  return res.render('user/actions', {
    title: 'Action Items',
    activeNav: 'actions',
    user: req.user,
    org: req.user.org,
    actions,
    groupedActions,
    selectedStatus: status,
    canAssign: canAssignActions(req.user),
    assignableUsers: await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).sort({ name:1,email:1 }).lean(),
    digest,
    meetings: await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1 }).sort({ startDateTime:-1 }).limit(100).lean(),
  });
});

router.post('/actions', requireUser, async (req, res) => {
  if (!canAssignActions(req.user)) return res.status(403).send('You do not have permission to assign action items.');
  const assignableForInfer = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).lean();
  const assignee = await User.findOne({ org: req.user.org._id, email: String(req.body.ownerEmail || '').toLowerCase().trim() }).lean();
  const transcriptId = String(req.body.transcriptDocId || '').trim();
  let meeting = null;
  if (transcriptId) meeting = await Transcript.findOne({ _id: transcriptId, orgId: req.user.org._id }).select({ _id:1, subject:1, startDateTime:1, eventId:1, meetingId:1, transcriptId:1, acl:1 }).lean();
  const due = parseDueDateISO(req.body.dueDateISO);
  let ownerEmail = String(req.body.ownerEmail || '').toLowerCase().trim();
  let ownerName = assignee?.name || ownerEmail || 'Unassigned';
  if (!ownerEmail) {
    const inferred = pickAssigneeFromText({ title: req.body.title, description: req.body.description }, assignableForInfer, meeting?.acl?.allowedEmails || []);
    ownerEmail = inferred.ownerEmail;
    ownerName = inferred.ownerName;
  }
  const acl = [...new Set([req.user.email, ownerEmail, ...(meeting?.acl?.allowedEmails || [])].map(x => String(x||'').toLowerCase().trim()).filter(Boolean))];
  const recurrenceEnabled = !!req.body.recurrenceEnabled;
  const frequency = recurrenceEnabled ? String(req.body.frequency || 'weekly') : '';
  const interval = Math.max(1, Number(req.body.interval || 1));
  const item = await ActionItem.create({ orgId: req.user.org._id, transcriptDocId: meeting?._id || null, eventId: meeting?.eventId || '', meetingId: meeting?.meetingId || '', transcriptId: meeting?.transcriptId || '', meetingSubject: meeting?.subject || '', meetingStartDateTime: meeting?.startDateTime || '', title: String(req.body.title || '').trim(), description: String(req.body.description || '').trim(), ownerName, ownerEmail, assignedByUserId: req.user._id, assignedByEmail: req.user.email, source: 'manual', dueDate: due ? due.toISOString().slice(0,10) : '', dueDateISO: due, priority: ['Low','Medium','High','Unclear'].includes(req.body.priority) ? req.body.priority : 'Medium', acl: { allowedEmails: acl, updatedAt: new Date() }, recurrence: { enabled: recurrenceEnabled, frequency, interval, nextDueAt: recurrenceEnabled ? nextDueFrom(due, frequency, interval) : null } });
  await writeAudit(req, 'ACTION_ASSIGNED', 'ActionItem', item._id, `Assigned action item to ${ownerName}`, { title: item.title, ownerEmail, recurring: recurrenceEnabled });
  return res.redirect('/user/actions');
});


router.get('/actions/:id', requireUser, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).send('Action item not found');
  const principals = getUserPrincipals(req.user);
  const item = await ActionItem.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).lean();
  if (!item) return res.status(404).send('Action item not found');
  const assignableUsers = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).sort({ name:1,email:1 }).lean();
  const meeting = item.transcriptDocId ? await Transcript.findOne({ _id: item.transcriptDocId, orgId: req.user.org._id }).select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1, hasTranscript:1 }).lean() : null;
  const thread = item.transcriptDocId ? await MeetingThread.findOne({ orgId: req.user.org._id, meetingIds: item.transcriptDocId, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, name:1, status:1 }).lean() : null;
  const relatedSignals = item.ownerEmail ? await PersonSignal.find({ orgId: req.user.org._id, personEmail: String(item.ownerEmail).toLowerCase().trim() }).sort({ detectedAt:-1 }).limit(8).lean() : [];
  return res.render('user/action_detail', { title: item.title, activeNav: 'actions', user: req.user, org: req.user.org, item, assignableUsers, meeting, thread, relatedSignals, canAssign: canAssignActions(req.user) });
});

router.post('/actions/:id/update', requireUser, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).send('Action item not found');
  if (!canAssignActions(req.user)) return res.status(403).send('You do not have permission to edit action items.');
  const principals = getUserPrincipals(req.user);
  const item = await ActionItem.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!item) return res.status(404).send('Action item not found');
  const assignee = req.body.ownerEmail ? await User.findOne({ org: req.user.org._id, email: String(req.body.ownerEmail).toLowerCase().trim() }).lean() : null;
  const due = parseNaturalDueDate(req.body.dueDateISO || req.body.dueDate || '');
  item.ownerEmail = assignee?.email || String(req.body.ownerEmail || '').toLowerCase().trim();
  item.ownerName = assignee?.name || item.ownerEmail || 'Unassigned';
  if (req.body.dueDateISO || req.body.dueDate) { item.dueDate = due.label || ''; item.dueDateISO = due.date; }
  if (['Low','Medium','High','Unclear'].includes(req.body.priority)) item.priority = req.body.priority;
  if (['Open','In Progress','Waiting','Done','Dropped'].includes(req.body.status)) item.status = req.body.status;
  const acl = new Set((item.acl?.allowedEmails || []).map(x => String(x||'').toLowerCase()).filter(Boolean));
  acl.add(String(req.user.email || '').toLowerCase());
  if (item.ownerEmail) acl.add(String(item.ownerEmail).toLowerCase());
  item.acl = { allowedEmails: Array.from(acl), updatedAt: new Date() };
  await item.save();
  await writeAudit(req, 'ACTION_UPDATED', 'ActionItem', item._id, `Updated action item ${item.title}`, { ownerEmail: item.ownerEmail, dueDate: item.dueDate, status: item.status, priority: item.priority });
  return res.redirect(req.get('referer') || '/user/actions/' + item._id);
});




router.post('/actions/:id/comment', requireUser, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).send('Action item not found');
  const principals = getUserPrincipals(req.user);
  const body = String(req.body.comment || '').trim();
  if (!body) return res.redirect(req.get('referer') || '/user/actions');
  const item = await ActionItem.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!item) return res.status(404).send('Action item not found');
  item.comments = item.comments || [];
  item.comments.push({ body: body.slice(0, 2000), createdBy: req.user._id, createdByEmail: req.user.email, createdAt: new Date() });
  await item.save();
  await writeAudit(req, 'ACTION_COMMENT_ADDED', 'ActionItem', item._id, `Added progress update to ${item.title}`);
  return res.redirect(req.get('referer') || '/user/actions');
});

router.post('/actions/:id/escalate', requireUser, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).send('Action item not found');
  const principals = getUserPrincipals(req.user);
  const note = String(req.body.escalationNote || req.body.comment || '').trim();
  const item = await ActionItem.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!item) return res.status(404).send('Action item not found');
  item.escalated = true;
  item.escalatedAt = new Date();
  item.escalatedByEmail = req.user.email;
  item.escalationNote = note.slice(0, 2000);
  item.comments = item.comments || [];
  item.comments.push({ body: `Escalated${note ? ': ' + note : ''}`, createdBy: req.user._id, createdByEmail: req.user.email, createdAt: new Date() });
  await item.save();
  await writeAudit(req, 'ACTION_ESCALATED', 'ActionItem', item._id, `Escalated action ${item.title}`, { note });
  return res.redirect(req.get('referer') || '/user/actions');
});

router.post('/actions/:id/reassign', requireUser, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).send('Action item not found');
  if (!canAssignActions(req.user)) return res.status(403).send('You do not have permission to reassign action items.');
  const principals = getUserPrincipals(req.user);
  const ownerEmail = String(req.body.ownerEmail || '').toLowerCase().trim();
  const assignee = ownerEmail ? await User.findOne({ org: req.user.org._id, email: ownerEmail }).lean() : null;
  const item = await ActionItem.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!item) return res.status(404).send('Action item not found');
  item.ownerEmail = ownerEmail;
  item.ownerName = assignee?.name || ownerEmail || 'Unassigned';
  const acl = new Set((item.acl?.allowedEmails || []).map(x => String(x||'').toLowerCase()).filter(Boolean));
  acl.add(String(req.user.email || '').toLowerCase());
  if (ownerEmail) acl.add(ownerEmail);
  item.acl = { allowedEmails: Array.from(acl), updatedAt: new Date() };
  item.comments = item.comments || [];
  item.comments.push({ body: `Reassigned to ${item.ownerName}`, createdBy: req.user._id, createdByEmail: req.user.email, createdAt: new Date() });
  await item.save();
  await writeAudit(req, 'ACTION_REASSIGNED', 'ActionItem', item._id, `Reassigned action to ${item.ownerName}`, { ownerEmail });
  return res.redirect(req.get('referer') || '/user/actions');
});

router.post('/calendar/:eventId/link-thread', requireUser, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  const threadId = String(req.body.threadId || '').trim();
  const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), eventId });
  if (!ev) return res.status(404).send('Meeting not found');
  if (!threadId) {
    ev.linkedThreadId = null;
    ev.linkedThreadName = '';
  } else {
    const principals = getUserPrincipals(req.user);
    const thread = await MeetingThread.findOne({ _id: threadId, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).lean();
    if (!thread) return res.status(404).send('Thread not found');
    ev.linkedThreadId = thread._id;
    ev.linkedThreadName = thread.name;
  }
  await ev.save();
  await writeAudit(req, 'MEETING_THREAD_LINKED', 'EventCache', eventId, `Linked calendar meeting to thread ${ev.linkedThreadName || 'none'}`);
  return res.redirect('/user/calendar#future');
});

router.post('/calendar/:eventId/context', requireUser, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), eventId }).lean();
  const allowed = [...new Set([req.user.email, ...(ev?.attendeeEmails || []), ev?.organizerEmail].map(x => String(x||'').toLowerCase().trim()).filter(Boolean))];
  await MeetingContext.create({ orgId: req.user.org._id, eventId, addedByUserId: req.user._id, addedByEmail: req.user.email, title: String(req.body.title || 'Meeting context').trim(), contextText: String(req.body.contextText || '').trim(), fileName: String(req.body.fileName || '').trim(), fileText: String(req.body.fileText || '').trim(), acl: { allowedEmails: allowed, updatedAt: new Date() } });
  await writeAudit(req, 'MEETING_CONTEXT_ADDED', 'EventCache', eventId, `Added context to meeting ${ev?.subject || eventId}`);
  return res.redirect('/user/calendar');
});

router.post('/calendar/:eventId/link-context-meeting', requireUser, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  const transcriptDocId = String(req.body.transcriptDocId || '').trim();
  const transcriptSearch = String(req.body.transcriptSearch || '').trim();
  const returnTo = String(req.body.returnTo || '/user/calendar');
  const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), eventId });
  if (!ev) return res.status(404).send('Meeting not found');
  const principals = getUserPrincipals(req.user);
  let prev = transcriptDocId ? await Transcript.findOne({ _id: transcriptDocId, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 }).lean() : null;
  if (!prev && transcriptSearch) {
    const m = transcriptSearch.match(/\[([a-f0-9]{24})\]/i);
    if (m) prev = await Transcript.findOne({ _id: m[1], orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 }).lean();
    if (!prev) {
      const cleaned = transcriptSearch.replace(/\[[a-f0-9]{24}\]/ig, '').split('—')[0].trim();
      if (cleaned) prev = await Transcript.findOne({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals }, subject: { $regex: cleaned.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&'), $options: 'i' } }).select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 }).sort({ startDateTime:-1, createdAt:-1 }).lean();
    }
  }
  if (!prev) return res.status(404).send('Context meeting not found or not accessible');
  ev.precedingTranscriptDocId = prev._id;
  ev.precedingSubject = prev.subject || 'Previous meeting';
  await ev.save();
  const allowed = [...new Set([req.user.email, ...(ev.attendeeEmails || []), ev.organizerEmail, ...(prev.acl?.allowedEmails || [])].map(x => String(x||'').toLowerCase().trim()).filter(Boolean))];
  const contextText = `Linked context meeting: ${prev.subject || 'Previous meeting'}\nTime: ${prettyLocalTimeLabel(prev.startDateTime) || prev.startDateTime || ''}\n\n${prev.ai?.summary || prev.ai?.detailedNotes || 'No generated summary available yet.'}`;
  await MeetingContext.create({ orgId: req.user.org._id, eventId, transcriptDocId: prev._id, addedByUserId: req.user._id, addedByEmail: req.user.email, title: `Context meeting: ${prev.subject || 'Previous meeting'}`, contextText, acl: { allowedEmails: allowed, updatedAt: new Date() } });
  await writeAudit(req, 'CONTEXT_MEETING_LINKED', 'EventCache', eventId, `Linked context meeting ${prev.subject || prev._id} to ${ev.subject || eventId}`);
  return res.redirect(returnTo.startsWith('/user/') ? returnTo : '/user/calendar');
});

router.post('/calendar/:eventId/manual-transcript', requireUser, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), eventId }).lean();
  if (!ev) return res.status(404).send('Meeting not found');
  const text = String(req.body.transcriptText || '').trim();
  if (!text) return res.status(400).send('Transcript text is required');
  const doc = await Transcript.create({ orgId: req.user.org._id, eventId, meetingId: `manual-${eventId}`, transcriptId: `manual-${Date.now()}`, subject: ev.subject || '', startDateTime: ev.startDateTime || '', endDateTime: ev.endDateTime || '', participantEmails: [...new Set([req.user.email, ...(ev.attendeeEmails || []), ev.organizerEmail].filter(Boolean))], vtt: '', text, ai: { status: 'none' }, acl: { allowedEmails: [...new Set([req.user.email, ...(ev.attendeeEmails || []), ev.organizerEmail].map(x => String(x||'').toLowerCase()).filter(Boolean))], updatedAt: new Date() } });
  await ensureTranscriptChunksForDoc(doc);
  await Transcript.updateOne({ _id: doc._id }, { $set: { aiIndexStatus: 'indexed', aiIndexedAt: new Date(), aiIndexError: '' } });
  await EventCache.updateOne({ _id: ev._id }, { $set: { hasTranscript: true, aiIndexStatus: 'indexed', aiIndexedAt: new Date(), aiIndexError: '' }, $push: { transcripts: transcriptRefFromDoc(doc) } });
  await writeAudit(req, 'MANUAL_TRANSCRIPT_LINKED', 'Transcript', doc._id, `Linked manual transcript to ${ev.subject}`);
  return res.redirect(`/user/transcript/saved/${doc._id}`);
});



router.post('/ai/load-all', requireUser, async (req, res) => {
  try {
    const orgId = req.user.org._id;
    const me = String(req.user.email || '').toLowerCase().trim();
    const principals = getUserPrincipals(req.user);
    const events = await EventCache.find({ orgId, userEmail: me, hasTranscript: true }).sort({ startDateTime:-1 }).limit(250).lean();
    let processed = 0, skipped = 0, failed = 0;
    for (const ev of events) {
      try {
        if (ev.aiIndexStatus === 'indexed' && ev.aiIndexedAt) { skipped++; continue; }
        let doc = await getOrCreateSharedTranscriptForEvent(orgId, ev, principals);
        if (!doc || !hasTranscriptPayload(doc)) { skipped++; continue; }
        const allowed = new Set([me, ...(ev.attendeeEmails || []), ev.organizerEmail, ...(doc.acl?.allowedEmails || []), ...(doc.participantEmails || [])].map(x => String(x||'').toLowerCase()).filter(Boolean));
        await Transcript.updateOne({ _id: doc._id }, { $set: { acl: { allowedEmails: Array.from(allowed), updatedAt: new Date() }, aiIndexStatus: 'processing', aiIndexError: '' } });
        doc = await Transcript.findById(doc._id);
        await ensureTranscriptChunksForDoc(doc);
        await upsertActionItemsForTranscriptOnce(doc, req.user._id).catch(()=>{});
        await Transcript.updateOne({ _id: doc._id }, { $set: { aiIndexStatus: 'indexed', aiIndexedAt: new Date(), aiIndexError: '' } });
        await EventCache.updateOne({ _id: ev._id }, { $set: { aiIndexStatus:'indexed', aiIndexedAt:new Date(), aiIndexError:'' }, $addToSet: { transcripts: transcriptRefFromDoc(doc) } });
        processed++;
      } catch(e) { failed++; }
    }
    const pendingAfter = await EventCache.countDocuments({ orgId, userEmail: me, hasTranscript: true, $or: [{ aiIndexStatus: { $ne: 'indexed' } }, { aiIndexedAt: { $exists: false } }, { aiIndexedAt: null }] });
    await UserSyncState.updateOne(
      { orgId, userEmail: me },
      { $set: { lastSyncedAt: new Date(), lastTranscriptAiLoadAt: new Date(), lastSyncStatus: failed ? 'error' : 'done', lastSyncStats: { processed, skipped, failed, pending: pendingAfter }, lastSyncError: failed ? `${failed} transcript(s) failed during manual load` : '' }, $setOnInsert: { orgId, userEmail: me } },
      { upsert: true }
    );
    if (processed > 0 || skipped > 0 || events.length > 0) {
      await User.updateOne({ _id: req.user._id }, { $set: { transcriptOnboardingDismissedAt: new Date() } });
      req.session.isFirstUserLogin = false;
    }
    return res.json({ ok:true, processed, skipped, failed, pending: pendingAfter, onboardingCleared: true });
  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message || 'load failed' });
  }
});

router.post('/calendar/:eventId/load-ai', requireUser, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  try {
    const doc = await loadAiContextForEvent(req, eventId);
    await writeAudit(req, 'MEETING_AI_CONTEXT_LOADED', 'Transcript', doc._id, `Loaded transcript into AI context for ${doc.subject || eventId}`);
    return res.redirect('/user/calendar?indexed=1');
  } catch (e) {
    const message = encodeURIComponent(e.message || 'Could not load meeting into AI context');
    return res.redirect(`/user/calendar?ragError=${message}`);
  }
});

router.post('/calendar/:eventId/send-pack', requireUser, ensureUserFreshToken, async (req, res) => {
  const eventId = String(req.params.eventId || '').trim();
  const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email).toLowerCase(), eventId }).lean();
  if (!ev) return res.status(404).send('Meeting not found');
  const recipients = [...new Set([ev.organizerEmail, ...(ev.attendeeEmails || [])].map(x => String(x||'').toLowerCase().trim()).filter(Boolean))];
  const transcript = await Transcript.findOne({ orgId: req.user.org._id, eventId }).sort({ createdAt: -1 }).lean();
  const actions = await ActionItem.find({ orgId: req.user.org._id, eventId }).sort({ createdAt: -1 }).lean();
  const actionText = actions.map((a,i) => `${i+1}. ${a.title}\nOwner: ${a.ownerName || 'Unassigned'} ${a.ownerEmail || ''}\nDue: ${a.dueDate || 'Unclear'}\nStatus: ${a.status}\n`).join('\n');
  const transcriptText = transcript?.text || 'No transcript available.';
  const subject = `MOM / Meeting pack: ${ev.subject || 'Meeting'}`;
  const body = `Hi all,\n\nSharing the meeting pack for: ${ev.subject || 'Meeting'}\n\nDate/Time: ${ev.startDateTime || ''}\n\nACTION ITEMS\n${actionText || 'No action items found.'}\n\nTRANSCRIPT / NOTES\n${transcriptText}\n\nRegards,\n${req.user.name || req.user.email}`;
  const attachments = [
    { name: 'action-items.txt', content: actionText || 'No action items found.' },
    { name: 'transcript.txt', content: transcriptText }
  ];
  const token = String(res.locals.userTokens?.access_token || '').trim();
  const fallback = buildMailFallback({ recipients, subject, body });
  if (!token) {
    await writeAudit(req, 'MEETING_PACK_OUTLOOK_FALLBACK', 'EventCache', eventId, `Opened Outlook fallback for meeting pack`, { recipients, reason: 'No Graph token' });
    return res.render('user/mom_compose', { title: 'Open MOM in Outlook', activeNav: 'calendar', user: req.user, org: req.user.org, recipients, subject, body, ...fallback, graphError: 'No Graph token available' });
  }
  try {
    await sendGraphMail(token, { to: recipients, subject, body, attachments });
    await writeAudit(req, 'MEETING_PACK_SENT', 'EventCache', eventId, `Sent transcript/action pack to attendees`, { recipients });
    return res.redirect('/user/calendar?sent=1');
  } catch (err) {
    const graphError = String(err && err.message ? err.message : err).slice(0, 700);
    await writeAudit(req, 'MEETING_PACK_OUTLOOK_FALLBACK', 'EventCache', eventId, `Graph send failed; opened Outlook fallback`, { recipients, graphError });
    return res.render('user/mom_compose', { title: 'Open MOM in Outlook', activeNav: 'calendar', user: req.user, org: req.user.org, recipients, subject, body, ...fallback, graphError });
  }
});

router.post('/threads/:id/remove-meeting', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const meetingId = String(req.body.meetingId || '').trim();
  await MeetingThread.updateOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }, { $pull: { meetingIds: meetingId } });
  return res.redirect('/user/threads');
});

router.get('/audit', requireUser, async (req, res) => {
  if (!canViewAudit(req.user)) return res.status(403).send('Forbidden');
  const logs = await AuditLog.find({ orgId: req.user.org._id }).sort({ createdAt: -1 }).limit(300).lean();
  return res.render('user/audit', { title: 'Audit Log', activeNav: 'audit', user: req.user, org: req.user.org, logs });
});

router.post('/actions/:id/status', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const status = String(req.body.status || 'Open');
  if (!['Open', 'In Progress', 'Waiting', 'Done', 'Dropped'].includes(status)) return res.status(400).send('Invalid status');
  await ActionItem.updateOne(
    { _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } },
    { $set: { status, updatedAt: new Date() } }
  );
  await writeAudit(req, 'ACTION_STATUS_UPDATED', 'ActionItem', req.params.id, `Action status changed to ${status}`, { status });
  return res.redirect(req.get('referer') || '/user/actions');
});


router.get('/shell/status', requireUser, async (req, res) => {
  const orgId = req.user.org._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const ownerScope = actionOwnerScopeForUser(req.user);
  const pendingActions = await ActionItem.find({ orgId, status: { $nin: ['Done','Dropped'] }, ...ownerScope })
    .select({ title:1, dueDate:1, dueDateISO:1, priority:1, meetingSubject:1, status:1, ownerName:1, ownerEmail:1, updatedAt:1 })
    .sort({ dueDateISO:1, createdAt:-1 })
    .limit(50)
    .lean();
  const now = Date.now();
  const overdueActions = pendingActions.filter(a => a.dueDateISO && new Date(a.dueDateISO).getTime() < now);
  const closedSince = startOfDay(addDays(new Date(), -7));
  const closedActions = await ActionItem.find({ orgId, status: 'Done', updatedAt: { $gte: closedSince }, ...ownerScope })
    .select({ title:1, dueDate:1, meetingSubject:1, status:1, updatedAt:1 })
    .sort({ updatedAt:-1 })
    .limit(30)
    .lean();
  const pendingTranscripts = await EventCache.countDocuments({ orgId, userEmail: me, hasTranscript: true, $or: [{ aiIndexStatus: { $ne: 'indexed' } }, { aiIndexedAt: { $exists: false } }, { aiIndexedAt: null }] });
  const totalWithTranscript = await EventCache.countDocuments({ orgId, userEmail: me, hasTranscript: true });
  const syncState = await UserSyncState.findOne({ orgId, userEmail: me }).lean();
  return res.json({
    ok: true,
    notifications: {
      assigned: pendingActions.length,
      overdue: overdueActions.length,
      closed: closedActions.length,
      items: {
        assigned: pendingActions,
        overdue: overdueActions,
        closed: closedActions,
      }
    },
    transcripts: {
      pending: pendingTranscripts,
      totalWithTranscript,
      lastTranscriptAiLoadAt: syncState?.lastTranscriptAiLoadAt || syncState?.lastSyncedAt || null,
      lastSyncStatus: syncState?.lastSyncStatus || 'idle',
      lastSyncError: syncState?.lastSyncError || ''
    }
  });
});


router.get('/chat/history', requireUser, async (req, res) => {
  const rows = await ChatMessage.find({ orgId: req.user.org._id, userId: req.user._id })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();
  return res.json({ ok: true, messages: rows.map(r => ({ role: r.role, message: r.message, sources: r.sources || [], createdAt: r.createdAt })) });
});

router.post('/chat/clear', requireUser, async (req, res) => {
  await ChatMessage.deleteMany({ orgId: req.user.org._id, userId: req.user._id });
  return res.json({ ok: true });
});

router.post('/transcripts/load-all', requireUser, ensureUserFreshToken, async (req, res) => {
  const key = String(req.user._id);
  global.__transcriptBackfill = global.__transcriptBackfill || {};
  const current = global.__transcriptBackfill[key];
  if (current && current.status === 'running') return res.json({ ok: true, status: current });
  global.__transcriptBackfill[key] = { status: 'running', startedAt: new Date(), message: 'Loading transcript memory for the last 30 days...' };
  sweepOnce()
    .then(stats => { global.__transcriptBackfill[key] = { status: 'done', finishedAt: new Date(), stats, message: 'Transcript memory is ready.' }; })
    .catch(e => { global.__transcriptBackfill[key] = { status: 'error', finishedAt: new Date(), error: e.message || String(e), message: 'Transcript memory load failed.' }; });
  return res.json({ ok: true, status: global.__transcriptBackfill[key] });
});

router.get('/transcripts/load-status', requireUser, async (req, res) => {
  const key = String(req.user._id);
  const orgId = req.user.org._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const liveStatus = (global.__transcriptBackfill && global.__transcriptBackfill[key]) || null;
  const pending = await EventCache.countDocuments({ orgId, userEmail: me, hasTranscript: true, $or: [{ aiIndexStatus: { $ne: 'indexed' } }, { aiIndexedAt: { $exists: false } }, { aiIndexedAt: null }] });
  const totalWithTranscript = await EventCache.countDocuments({ orgId, userEmail: me, hasTranscript: true });
  const syncState = await UserSyncState.findOne({ orgId, userEmail: me }).lean();
  const status = liveStatus || { status: syncState?.lastSyncStatus || 'idle', message: pending ? `${pending} transcript(s) pending AI load.` : 'Transcript AI memory is up to date.' };
  return res.json({ ok: true, status, pending, totalWithTranscript, lastTranscriptAiLoadAt: syncState?.lastTranscriptAiLoadAt || syncState?.lastSyncedAt || null, lastSyncStatus: syncState?.lastSyncStatus || status.status || 'idle', lastSyncError: syncState?.lastSyncError || '' });
});

router.get('/settings', requireUser, async (req, res) => {
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1, role:1 }).sort({ name:1, email:1 }).lean();
  const freshUser = await User.findById(req.user._id).lean();
  return res.render('user/settings', { title: 'My Settings', activeNav: 'settings', user: { ...req.user, ...(freshUser || {}) }, org: req.user.org, users });
});

// v17.3: dedicated collaborator management screen.
router.get('/collaborators', requireUser, async (req, res) => {
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1, role:1 }).sort({ name:1, email:1 }).lean();
  const freshUser = await User.findById(req.user._id).lean();
  const me = String(req.user.email || '').toLowerCase().trim();
  const owners = await User.find({ org: req.user.org._id, 'collaborators.email': me })
    .select({ name:1, email:1, collaborators:1 })
    .sort({ name:1, email:1 })
    .lean();
  const delegatedBy = owners.map(o => {
    const c = (o.collaborators || []).find(x => String(x.email || '').toLowerCase() === me) || {};
    return { owner: { name: o.name, email: o.email }, role: c.role || 'collaborator', canAddContext: !!c.canAddContext, canAddActions: !!c.canAddActions };
  });
  return res.render('user/collaborators', { title: 'Collaborators', activeNav: 'collaborators', user: { ...req.user, ...(freshUser || {}) }, org: req.user.org, users, delegatedBy });
});

// v17.3: assistant/delegate workbench. This is where collaborators see work they can contribute to.
router.get('/assistant', requireUser, async (req, res) => {
  const me = String(req.user.email || '').toLowerCase().trim();
  const principals = getUserPrincipals(req.user).map(x => String(x || '').toLowerCase());
  const owners = await User.find({ org: req.user.org._id, 'collaborators.email': me })
    .select({ name:1, email:1, collaborators:1 })
    .sort({ name:1, email:1 })
    .lean();
  const delegatedBy = owners.map(o => {
    const c = (o.collaborators || []).find(x => String(x.email || '').toLowerCase() === me) || {};
    return { owner: { name: o.name, email: o.email }, role: c.role || 'collaborator', canAddContext: !!c.canAddContext, canAddActions: !!c.canAddActions };
  });
  const contributorThreads = await MeetingThread.find({
    orgId: req.user.org._id,
    deletedAt: null,
    status: { $ne: 'Closed' },
    $or: [
      { contributorEmails: { $in: principals } },
      { ownerEmail: { $in: principals } },
      { 'acl.allowedEmails': { $in: principals } }
    ]
  })
    .select({ name:1, objective:1, status:1, ownerEmail:1, contributorEmails:1, viewerEmails:1, updatedAt:1, ai:1 })
    .sort({ updatedAt:-1 })
    .limit(80)
    .lean();
  const assignedActions = await ActionItem.find({ orgId: req.user.org._id, ownerEmail: { $in: principals }, status: { $in: ['Open','In Progress'] } })
    .sort({ dueDateISO: 1, createdAt: -1 })
    .limit(40)
    .lean();
  return res.render('user/assistant', { title: 'Assistant workbench', activeNav: 'assistant', user: req.user, org: req.user.org, delegatedBy, contributorThreads, assignedActions, fmtTime: formatThreadTime });
});



// v17.4: assistants/collaborators can add notes on behalf of people who delegated to them.
router.post('/assistant/notes', requireUser, async (req, res) => {
  const me = String(req.user.email || '').toLowerCase().trim();
  const onBehalfOfEmail = String(req.body.onBehalfOfEmail || '').toLowerCase().trim();
  if (!onBehalfOfEmail) return res.redirect('/user/assistant');

  const owner = await User.findOne({ org: req.user.org._id, email: onBehalfOfEmail }).select({ name:1, email:1, collaborators:1 }).lean();
  if (!owner) return res.status(404).send('Delegating user not found');
  const delegation = (owner.collaborators || []).find(c => String(c.email || '').toLowerCase().trim() === me);
  if (!delegation || !delegation.canAddContext) return res.status(403).send('You are not allowed to add context on behalf of this user.');

  const noteType = ['personal_note','general','call','manual_meeting','generated'].includes(req.body.noteType) ? req.body.noteType : 'general';
  const raw = String(req.body.note || req.body.contextText || '').trim();
  if (!raw) return res.redirect('/user/assistant');
  const title = String(req.body.title || '').trim() || (noteType === 'call' ? 'Call note' : noteType === 'manual_meeting' ? 'Manual meeting' : 'Delegated note');
  const people = uniqEmails([...(parseCsvEmails(req.body.people || req.body.participants) || []), me, onBehalfOfEmail]);
  const sourceType = noteType === 'call' ? 'Call note' : noteType === 'manual_meeting' ? 'Manual meeting' : noteType === 'generated' ? 'AI-generated note' : noteType === 'personal_note' ? 'Personal note' : 'Manual note';
  const clean = noteType === 'generated' ? raw.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(x=>'• '+x.replace(/^[-•]\s*/, '')).join('\n') : raw;
  const contextText = [
    `Added on behalf of: ${owner.name || owner.email} <${owner.email}>.`,
    `Captured by: ${req.user.name || req.user.email} <${req.user.email}>.`,
    people.length ? `People: ${people.join(', ')}.` : '',
    `Note: ${clean}`,
  ].filter(Boolean).join('\n');

  const ctx = await MeetingContext.create({
    orgId: req.user.org._id,
    contextType: noteType,
    sourceType,
    visibility: noteType === 'personal_note' ? 'private' : 'thread',
    people,
    addedByUserId: owner._id,
    addedByEmail: owner.email,
    title,
    contextText,
    occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
    acl: { allowedEmails: uniqEmails([owner.email, me, ...people]), updatedAt: new Date() },
  });
  await writeAudit(req, 'ASSISTANT_NOTE_ADDED_ON_BEHALF', 'MeetingContext', ctx._id, `Added note on behalf of ${owner.email}`, { onBehalfOfEmail: owner.email, capturedBy: me, noteType, title });
  return res.redirect(req.body.returnTo || '/user/assistant');
});

router.post('/settings/collaborators', requireUser, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.redirect('/user/settings');
  const name = String(req.body.name || '').trim();
  const role = ['assistant','delegate','collaborator'].includes(req.body.role) ? req.body.role : 'collaborator';
  const canAddContext = req.body.canAddContext === 'on' || req.body.canAddContext === 'true';
  const canAddActions = req.body.canAddActions === 'on' || req.body.canAddActions === 'true';
  await User.updateOne(
    { _id: req.user._id },
    {
      $pull: { collaborators: { email } },
    }
  );
  await User.updateOne(
    { _id: req.user._id },
    { $push: { collaborators: { email, name, role, canAddContext, canAddActions, addedAt: new Date() } } }
  );
  await writeAudit(req, 'USER_COLLABORATOR_ADDED', 'User', req.user._id, `Added collaborator ${email}`);
  return res.redirect(req.body.returnTo || '/user/collaborators');
});

router.post('/settings/collaborators/remove', requireUser, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (email) {
    await User.updateOne({ _id: req.user._id }, { $pull: { collaborators: { email } } });
    await writeAudit(req, 'USER_COLLABORATOR_REMOVED', 'User', req.user._id, `Removed collaborator ${email}`);
  }
  return res.redirect(req.body.returnTo || '/user/collaborators');
});


router.post('/settings/memory', requireUser, async (req, res) => {
  const label = String(req.body.label || '').trim() || 'Memory note';
  const body = String(req.body.body || '').trim();
  const scope = ['user','org'].includes(req.body.scope) ? req.body.scope : 'user';
  if (body) {
    await User.updateOne(
      { _id: req.user._id },
      { $push: { memoryBlocks: { scope, label, body, createdByEmail: req.user.email, createdAt: new Date(), updatedAt: new Date() } } }
    );
    await writeAudit(req, 'USER_MEMORY_ADDED', 'User', req.user._id, `Added memory block ${label}`, { scope });
  }
  return res.redirect('/user/settings');
});

router.post('/settings/memory/remove', requireUser, async (req, res) => {
  const id = String(req.body.id || '').trim();
  if (id) await User.updateOne({ _id: req.user._id }, { $pull: { memoryBlocks: { _id: id } } });
  return res.redirect('/user/settings');
});


// v17: lightweight people search used by Add Note and chat-assist UI.
router.get('/people/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, people: [] });
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const users = await User.find({ org: req.user.org._id, status: 'active', $or: [{ name: rx }, { email: rx }] })
    .select({ name:1, email:1 })
    .sort({ name:1, email:1 })
    .limit(12)
    .lean();
  const people = users.map(u => ({ name: u.name || u.email, email: u.email }));
  return res.json({ ok: true, people });
});




function parseCsvEmails(value) {
  return String(value || '').split(/[;,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
}
function uniqEmails(list) { return [...new Set((list || []).map(x => String(x||'').trim().toLowerCase()).filter(Boolean))]; }
function formatThreadTime(d) {
  try { return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }); } catch(e) { return d || ''; }
}
function threadAccessQuery(req) {
  const principals = getUserPrincipals(req.user);
  return { orgId: req.user.org._id, deletedAt: null, $or: [{ 'acl.allowedEmails': { $in: principals } }, { ownerEmail: { $in: principals } }, { contributorEmails: { $in: principals } }, { viewerEmails: { $in: principals } }] };
}
function canOwnThread(req, thread) {
  const principals = getUserPrincipals(req.user).map(x => String(x).toLowerCase());
  return String(thread.ownerUserId || '') === String(req.user._id) || principals.includes(String(thread.ownerEmail || '').toLowerCase());
}
function canContributeThread(req, thread) {
  const principals = getUserPrincipals(req.user).map(x => String(x).toLowerCase());
  if (canOwnThread(req, thread)) return true;
  return (thread.contributorEmails || []).some(e => principals.includes(String(e).toLowerCase()));
}
function sourceForKind(kind) {
  return ({ call:'Call note', generated_note:'AI-generated note', meeting:'Manual meeting', decision:'Decision', risk:'Risk', action:'Action', note:'Manual note', status:'Manual note' })[kind] || 'Manual note';
}
function normalizeSubjectKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\|\|.*$/g, '')
    .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}\b/gi, '')
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/gi, '')
    .replace(/\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digestFromThread(thread) {
  const entries = thread.entries || [];
  const openRisks = entries.filter(e => e.kind === 'risk' && !/closed|done|resolved/i.test(e.status || '')).length;
  const openActions = entries.filter(e => e.kind === 'action' && !/done|closed|complete/i.test(e.status || '')).length;
  const overdueActions = entries.filter(e => e.kind === 'action' && e.dueDate && new Date(e.dueDate) < new Date() && !/done|closed|complete/i.test(e.status || '')).length;
  const latest = entries.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,3).map(e => `${e.kind}: ${e.title || e.body || 'context added'}`).join('; ');
  return {
    whatChanged: latest || 'No new manual context captured yet.',
    openRisks: `${openRisks} open risk(s)`,
    overdueActions: `${overdueActions} overdue action(s) out of ${openActions} open action(s)`,
    attentionToday: overdueActions ? 'Review overdue actions and unblock owners.' : (openRisks ? 'Review open risks and mitigation owners.' : 'No urgent thread-level attention flagged.'),
  };
}


router.get('/people', requireUser, async (req, res) => {
  const people = await buildPeopleDirectory(req.user.org._id);
  const q = String(req.query.q || '').toLowerCase().trim();
  const filtered = q ? people.filter(p => `${p.name} ${p.email} ${(p.aliases||[]).join(' ')}`.toLowerCase().includes(q)) : people;
  const signals = await PersonSignal.find({ orgId: req.user.org._id }).sort({ detectedAt: -1 }).limit(40).lean();
  return res.render('user/people', { title: 'People Intelligence', activeNav: 'people', user: req.user, org: req.user.org, people: filtered, q, signals });
});

router.post('/people/refresh', requireUser, async (req, res) => {
  await refreshPersonSignals(req.user.org._id);
  return res.redirect('/user/people');
});

router.get('/people/:email', requireUser, async (req, res) => {
  const email = String(req.params.email || '').toLowerCase().trim();
  const people = await buildPeopleDirectory(req.user.org._id);
  const person = people.find(p => p.email === email);
  if (!person) return res.status(404).send('Person not found');
  const actions = await ActionItem.find({ orgId: req.user.org._id, ownerEmail: email }).sort({ status: 1, dueDateISO: 1, updatedAt: -1 }).limit(100).lean();
  const ownedThreads = await MeetingThread.find({ orgId: req.user.org._id, ownerEmail: email, deletedAt: null }).select({ name:1,status:1,priority:1,updatedAt:1 }).sort({ updatedAt:-1 }).lean();
  const contributingThreads = await MeetingThread.find({ orgId: req.user.org._id, contributorEmails: email, deletedAt: null }).select({ name:1,status:1,priority:1,updatedAt:1 }).sort({ updatedAt:-1 }).lean();
  const aliases = await PersonAlias.find({ orgId: req.user.org._id, canonicalEmail: email }).sort({ alias:1 }).lean();
  const signals = await PersonSignal.find({ orgId: req.user.org._id, personEmail: email }).sort({ detectedAt:-1 }).limit(80).lean();
  return res.render('user/person_detail', { title: person.name || email, activeNav: 'people', user: req.user, org: req.user.org, person, actions, ownedThreads, contributingThreads, aliases, signals });
});

router.post('/people/:email/aliases', requireUser, async (req, res) => {
  const email = String(req.params.email || '').toLowerCase().trim();
  const alias = String(req.body.alias || '').trim();
  if (email && alias) {
    await PersonAlias.findOneAndUpdate({ orgId: req.user.org._id, normalizedAlias: alias.toLowerCase() }, { $set: { orgId: req.user.org._id, canonicalEmail: email, canonicalName: String(req.body.canonicalName || '').trim(), alias, normalizedAlias: alias.toLowerCase(), createdBy: req.user._id, createdByEmail: req.user.email } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    await writeAudit(req, 'PERSON_ALIAS_ADDED', 'PersonAlias', email, `Added alias ${alias} for ${email}`);
  }
  return res.redirect('/user/people/' + encodeURIComponent(email));
});

router.get('/threads', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const threads = await MeetingThread.find(threadAccessQuery(req)).sort({ updatedAt: -1 }).lean();
  const meetings = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ _id: 1, subject: 1, startDateTime: 1 })
    .sort({ startDateTime: -1 })
    .limit(200)
    .lean();
  const now = new Date();
  const upcoming = await EventCache.find({ orgId: req.user.org._id, startDateTime: { $gte: now }, linkedThreadId: { $in: threads.map(t=>t._id) } })
    .select({ linkedThreadId:1, subject:1, startDateTime:1 })
    .sort({ startDateTime: 1 }).limit(300).lean();
  const nextByThread = {};
  for (const ev of upcoming) { const k=String(ev.linkedThreadId); if(!nextByThread[k]) nextByThread[k]=ev; }
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).sort({ name:1,email:1 }).lean();
  return res.render('user/threads', { title: 'Outcome Threads', activeNav: 'threads', user: req.user, org: req.user.org, threads, meetings, nextByThread, fmtTime: formatThreadTime, users });
});


// v16.5: personal notes / reminders. These enter the same RAG memory as meeting context,
// but default to private-to-me so Kili can recall them without exposing them to thread/org users.
router.post('/notes', requireUser, async (req, res) => {
  const raw = String(req.body.note || req.body.contextText || '').trim();
  if (!raw) return res.redirect(req.body.returnTo || '/user/home');
  const noteType = ['personal_note','general','call','manual_meeting','generated'].includes(req.body.noteType) ? req.body.noteType : 'personal_note';
  const title = String(req.body.title || '').trim() || (noteType === 'call' ? 'Call note' : noteType === 'manual_meeting' ? 'Manual meeting' : (raw.length > 70 ? raw.slice(0, 67) + '…' : raw));
  const remind = String(req.body.remindUntil || '').trim();
  const parsed = remind ? parseNaturalDueDate(remind) : { date: null };
  const me = String(req.user.email || '').toLowerCase().trim();
  const people = uniqEmails(parseCsvEmails(req.body.people || req.body.peopleHidden || req.body.participants));
  const sourceType = noteType === 'call' ? 'Call note' : noteType === 'manual_meeting' ? 'Manual meeting' : noteType === 'generated' ? 'AI-generated note' : noteType === 'personal_note' ? 'Personal note' : 'Manual note';
  const visibility = noteType === 'personal_note' ? 'private' : (['private','thread','org'].includes(req.body.visibility) ? req.body.visibility : 'private');
  const text = noteType === 'generated'
    ? `Clean note\n\n${raw.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(x=>'• '+x.replace(/^[-•]\s*/, '')).join('\n')}`
    : raw;
  const smartText = [
    `${sourceType}.`,
    people.length ? `People: ${people.join(', ')}.` : '',
    parsed.date ? `Reminder / keep-active-until: ${parsed.label || parsed.date.toISOString().slice(0,10)}.` : (/remember me|remind me|until|till/i.test(raw) ? 'Reminder intent detected, but due date is unclear.' : ''),
    `Note: ${text}`,
  ].filter(Boolean).join('\n');
  const ctx = await MeetingContext.create({
    orgId: req.user.org._id,
    contextType: noteType,
    sourceType,
    visibility,
    people,
    addedByUserId: req.user._id,
    addedByEmail: me,
    title,
    contextText: smartText,
    occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
    remindUntil: parsed.date || null,
    noteStatus: 'active',
    acl: { allowedEmails: uniqEmails([me, ...people]), updatedAt: new Date() },
  });
  await writeAudit(req, 'MEMORY_CONTEXT_ADDED', 'MeetingContext', ctx._id, `Added ${sourceType} ${title}`);
  return res.redirect(req.body.returnTo || '/user/home');
});

router.post('/notes/:id/done', requireUser, async (req, res) => {
  const me = String(req.user.email || '').toLowerCase().trim();
  await MeetingContext.updateOne({ _id: req.params.id, orgId: req.user.org._id, contextType: 'personal_note', addedByEmail: me }, { $set: { noteStatus: 'done', updatedAt: new Date() } });
  return res.redirect(req.body.returnTo || '/user/home');
});

router.post('/contexts', requireUser, async (req, res) => {
  const type = ['call','general','generated','manual_meeting','personal_note'].includes(req.body.contextType) ? req.body.contextType : 'general';
  const threadId = String(req.body.threadId || '').trim();
  let thread = null;
  if (threadId) {
    thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: threadId });
    if (!thread) return res.status(404).send('Thread not found');
    if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can add context to this thread.');
  }
  const raw = String(req.body.contextText || req.body.note || '').trim();
  let text = raw;
  if (type === 'generated' && raw) text = `Clean note\n\n${raw.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(x=>'• '+x.replace(/^[-•]\s*/, '')).join('\n')}`;
  const title = String(req.body.title || (type === 'call' ? 'Call note' : type === 'manual_meeting' ? 'Manual meeting' : type === 'generated' ? 'Generated note' : 'General note')).trim();
  const people = parseCsvEmails(req.body.people || req.body.participants);
  const visibility = ['private','thread','org'].includes(req.body.visibility) ? req.body.visibility : (thread ? 'thread' : 'private');
  const allowed = uniqEmails([...(getUserPrincipals(req.user)||[]), ...(thread?.acl?.allowedEmails || [])]);
  const ctx = await MeetingContext.create({ orgId: req.user.org._id, threadId: thread?._id || null, addedByUserId: req.user._id, addedByEmail: req.user.email, title, contextText: text, contextType: type, sourceType: type==='call'?'Call note':type==='generated'?'AI-generated note':type==='manual_meeting'?'Manual meeting':type==='personal_note'?'Personal note':'Manual note', visibility, people, occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(), acl: { allowedEmails: allowed, updatedAt: new Date() } });
  if (thread) {
    const kind = type === 'call' ? 'call' : type === 'manual_meeting' ? 'meeting' : type === 'generated' ? 'generated_note' : 'note';
    await MeetingThread.updateOne({ _id: thread._id }, { $push: { entries: { kind, sourceType: sourceForKind(kind), visibility, title, body: text, people, occurredAt: ctx.occurredAt, createdBy: req.user._id, createdByEmail: req.user.email, createdAt: new Date() } }, $set: { updatedAt: new Date() } });
  }
  await writeAudit(req, 'CONTEXT_ADDED', thread ? 'MeetingThread' : 'MeetingContext', thread?._id || ctx._id, `Added ${type} context`);
  return res.redirect(thread ? '/user/threads/' + thread._id : '/user/threads');
});


router.post('/threads/:id/metrics', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can create metrics.');
  const name = String(req.body.name || '').trim();
  if (!name) return res.redirect('/user/threads/' + req.params.id);
  const value = Number(req.body.value || 0);
  const recordedAt = req.body.recordedAt ? new Date(req.body.recordedAt) : new Date();
  const allowedEmails = uniqEmails([...(thread.acl?.allowedEmails || []), ...(getUserPrincipals(req.user) || [])]);
  const metric = await ThreadMetric.create({
    orgId: req.user.org._id,
    threadId: thread._id,
    name: name.slice(0, 120),
    description: String(req.body.description || '').trim().slice(0, 1000),
    unit: String(req.body.unit || 'count').trim().slice(0, 40) || 'count',
    chartType: ['line','bar','area','step','pie','cumulative','scatter','gauge'].includes(req.body.chartType) ? req.body.chartType : 'line',
    direction: ['higher_is_better','lower_is_better','neutral'].includes(req.body.direction) ? req.body.direction : 'neutral',
    points: [{ value, note: String(req.body.note || '').trim().slice(0, 1000), recordedAt, recordedBy: req.user._id, recordedByEmail: req.user.email }],
    acl: { allowedEmails, updatedAt: new Date() },
    createdBy: req.user._id,
    createdByEmail: req.user.email,
  });
  await writeAudit(req, 'THREAD_METRIC_CREATED', 'ThreadMetric', metric._id, `Created metric ${metric.name}`);
  return res.redirect('/user/threads/' + thread._id + '#metrics');
});

router.post('/threads/:id/metrics/:metricId/points', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can update metrics.');
  const metric = await ThreadMetric.findOne({ _id: req.params.metricId, orgId: req.user.org._id, threadId: thread._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } });
  if (!metric) return res.status(404).send('Metric not found');
  metric.points = metric.points || [];
  metric.points.push({ value: Number(req.body.value || 0), note: String(req.body.note || '').trim().slice(0, 1000), recordedAt: req.body.recordedAt ? new Date(req.body.recordedAt) : new Date(), recordedBy: req.user._id, recordedByEmail: req.user.email });
  await metric.save();
  await writeAudit(req, 'THREAD_METRIC_POINT_ADDED', 'ThreadMetric', metric._id, `Updated metric ${metric.name}`);
  return res.redirect('/user/threads/' + thread._id + '#metrics');
});

router.post('/threads/:id/metrics/:metricId/settings', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can update metrics.');
  const metric = await ThreadMetric.findOne({ _id: req.params.metricId, orgId: req.user.org._id, threadId: thread._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } });
  if (!metric) return res.status(404).send('Metric not found');
  metric.chartType = ['line','bar','area','step','pie','cumulative','scatter','gauge'].includes(req.body.chartType) ? req.body.chartType : metric.chartType;
  metric.direction = ['higher_is_better','lower_is_better','neutral'].includes(req.body.direction) ? req.body.direction : metric.direction;
  metric.unit = String(req.body.unit || metric.unit || 'count').trim().slice(0, 40);
  await metric.save();
  return res.redirect('/user/threads/' + thread._id + '#metrics');
});


router.post('/threads/:id/auto-link-recurring', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can auto-link recurring meetings.');
  const principals = getUserPrincipals(req.user);
  const key = String(thread.recurringChain?.subjectKey || thread.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = key.split(/\s+/).filter(w => w.length >= 4).slice(0, 5);
  if (!words.length) return res.redirect('/user/threads/' + thread._id);
  const ors = words.map(w => ({ subject: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
  const matches = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals }, $or: ors })
    .select({ _id:1, subject:1, startDateTime:1, acl:1 })
    .sort({ startDateTime: -1 })
    .limit(60)
    .lean();
  const existing = new Set((thread.meetingIds || []).map(String));
  const additions = matches.filter(m => !existing.has(String(m._id))).slice(0, 25);
  if (additions.length) {
    const allowedEmails = uniqEmails([...(thread.acl?.allowedEmails || []), ...additions.flatMap(m => m.acl?.allowedEmails || []), ...principals]);
    await MeetingThread.updateOne({ _id: thread._id }, { $addToSet: { meetingIds: { $each: additions.map(m => m._id) } }, $set: { 'recurringChain.enabled': true, 'recurringChain.matchMode': 'subject', 'recurringChain.subjectKey': key, 'recurringChain.lastConnectedAt': new Date(), 'recurringChain.connectedCount': (thread.meetingIds || []).length + additions.length, 'acl.allowedEmails': allowedEmails, updatedAt: new Date() } });
    await writeAudit(req, 'THREAD_RECURRING_AUTO_LINKED', 'MeetingThread', thread._id, `Auto-linked ${additions.length} recurring meeting(s)`);
  }
  return res.redirect('/user/threads/' + thread._id + '#warroom');
});

router.get('/threads/:id/closure-report', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).lean();
  if (!thread) return res.status(404).send('Thread not found');
  const principals = getUserPrincipals(req.user);
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ subject:1,startDateTime:1,'ai.summary':1 }).sort({ startDateTime:1 }).lean();
  const actions = await ActionItem.find({ orgId: req.user.org._id, transcriptDocId: { $in: thread.meetingIds || [] }, 'acl.allowedEmails': { $in: principals } }).sort({ status:1,dueDateISO:1 }).lean();
  const entries = thread.entries || [];
  const report = [
    `Thread Closure Report: ${thread.name}`,
    `Status: ${thread.status || 'Active'}`,
    `Owner: ${thread.ownerEmail || 'Unassigned'}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Objective',
    thread.objective || 'Not set',
    '',
    'Health',
    `${thread.ai?.healthLabel || ''} ${thread.ai?.healthScore || ''}`.trim() || 'Not scored',
    '',
    'Meetings linked',
    meetings.length ? meetings.map((m,i)=>`${i+1}. ${m.subject || 'Meeting'} — ${m.startDateTime || ''}`).join('\n') : 'No meetings linked.',
    '',
    'Decisions',
    entries.filter(e=>e.kind==='decision').map((e,i)=>`${i+1}. ${e.title || e.body || 'Decision'} — ${e.status || ''}`).join('\n') || 'No decisions captured.',
    '',
    'Risks / blockers',
    entries.filter(e=>e.kind==='risk' || /block|wait|dependency|stuck/i.test((e.title||'')+' '+(e.body||''))).map((e,i)=>`${i+1}. ${e.title || e.body || e.kind} — ${e.severity || ''} ${e.status || ''}`).join('\n') || 'No risks/blockers captured.',
    '',
    'Actions',
    actions.map((a,i)=>`${i+1}. ${a.title} — ${a.status}; owner=${a.ownerName || a.ownerEmail || 'Unassigned'}; due=${a.dueDate || 'Unclear'}`).join('\n') || 'No actions linked.',
    '',
    'AI summary',
    thread.ai?.progressSummary || 'No AI thread summary generated yet.'
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="thread-closure-${thread._id}.txt"`);
  res.send(report);
});


router.get('/threads/:id', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).lean();
  if (!thread) return res.status(404).send('Thread not found');
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1 })
    .sort({ startDateTime: 1 })
    .lean();
  // v24.9: Add-meetings picker should show only meetings scheduled up to today, not future meetings.
  const endOfTodayForPicker = endOfDay(new Date());
  const allMeetings = await Transcript.find({
    orgId: req.user.org._id,
    'acl.allowedEmails': { $in: getUserPrincipals(req.user) },
    $or: [
      { startDateTime: { $lte: endOfTodayForPicker } },
      { startDateTime: { $lte: endOfTodayForPicker.toISOString() } },
      { startDateTime: { $exists: false } },
      { startDateTime: null }
    ]
  })
    .select({ _id: 1, subject: 1, startDateTime: 1 })
    .sort({ startDateTime: -1 })
    .limit(240)
    .lean();
  const canOwner = canOwnThread(req, thread);
  const canContrib = canContributeThread(req, thread);
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).sort({ name:1,email:1 }).lean();
  const metrics = await ThreadMetric.find({ orgId: req.user.org._id, threadId: thread._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).sort({ updatedAt: -1 }).lean();
  const threadActions = await ActionItem.find({ orgId: req.user.org._id, transcriptDocId: { $in: thread.meetingIds || [] }, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).select({ status:1, dueDateISO:1, updatedAt:1 }).lean();
  const actionStats = { total: threadActions.length, open: 0, waiting: 0, overdue: 0, done: 0, stale: 0 };
  const now = Date.now();
  for (const a of threadActions) {
    if (a.status === 'Done') actionStats.done += 1;
    if (['Open','In Progress','Waiting'].includes(a.status)) actionStats.open += 1;
    if (a.status === 'Waiting') actionStats.waiting += 1;
    if (a.dueDateISO && new Date(a.dueDateISO).getTime() < now && !['Done','Dropped'].includes(a.status)) actionStats.overdue += 1;
    if (a.updatedAt && now - new Date(a.updatedAt).getTime() > 5*24*60*60*1000 && !['Done','Dropped'].includes(a.status)) actionStats.stale += 1;
  }
  return res.render('user/thread_detail', { title: thread.name, activeNav: 'threads', user: req.user, org: req.user.org, thread, meetings, allMeetings, canOwner, canContrib, fmtTime: formatThreadTime, users, metrics, actionStats });
});

router.post('/threads', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const name = String(req.body.name || '').trim() || 'Outcome thread';
  const objective = String(req.body.objective || req.body.outcome || '').trim();
  const status = 'Active';
  const contributorEmails = parseCsvEmails(req.body.contributorEmails || req.body.memberEmails);
  const viewerEmails = parseCsvEmails(req.body.viewerEmails || '');
  const meetingIds = Array.isArray(req.body.meetingIds) ? req.body.meetingIds : [req.body.meetingIds].filter(Boolean);
  const meetings = await Transcript.find({ _id: { $in: meetingIds }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id: 1, acl: 1 }).lean();
  const ownerEmail = String(req.user.email || '').toLowerCase();
  const acl = uniqEmails([...(principals || []), ownerEmail, ...contributorEmails, ...viewerEmails, ...meetings.flatMap(m => m.acl?.allowedEmails || [])]);
  const created = await MeetingThread.create({ orgId: req.user.org._id, name, objective, desiredOutcome: '', status, ownerEmail, contributorEmails, viewerEmails, memberEmails: uniqEmails([...contributorEmails, ...viewerEmails]), meetingIds: meetings.map(m => m._id), createdBy: req.user._id, ownerUserId: req.user._id, acl: { allowedEmails: acl, updatedAt: new Date() } });
  return res.redirect('/user/threads/' + created._id);
});

router.post('/threads/:id/update', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  const isOwner = canOwnThread(req, thread);
  // v24.8.1: users can edit thread metadata, but status and health are AI-derived and read-only in the UI.
  // Preserve the current status/health here even if an older browser posts stale fields.
  const update = { name: String(req.body.name || '').trim() || thread.name || 'Outcome thread', objective: String(req.body.objective || req.body.outcome || '').trim(), desiredOutcome: '', priority: String(req.body.priority || '').trim(), updatedAt: new Date() };
  if (isOwner) {
    update.contributorEmails = parseCsvEmails(req.body.contributorEmails || req.body.memberEmails);
    update.viewerEmails = parseCsvEmails(req.body.viewerEmails || '');
    update.memberEmails = uniqEmails([...(update.contributorEmails||[]), ...(update.viewerEmails||[])]);
    update['acl.allowedEmails'] = uniqEmails([thread.ownerEmail, ...(getUserPrincipals(req.user)||[]), ...(update.contributorEmails||[]), ...(update.viewerEmails||[])]);
    update['acl.updatedAt'] = new Date();
  }
  await MeetingThread.updateOne({ _id: thread._id }, { $set: update });
  return res.redirect('/user/threads/' + req.params.id);
});


router.post('/threads/:id/intelligence-fields', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can edit thread intelligence fields.');
  const keyDecisionsNeeded = String(req.body.keyDecisionsNeeded || '').trim();
  const keyGaps = String(req.body.keyGaps || '').trim();
  const keyQuestions = String(req.body.keyQuestions || '').trim();
  const bodyParts = [];
  if (keyDecisionsNeeded) bodyParts.push('Key things to decide:\n' + keyDecisionsNeeded);
  if (keyGaps) bodyParts.push('Key gaps:\n' + keyGaps);
  if (keyQuestions) bodyParts.push('Open questions / things to watch:\n' + keyQuestions);
  const entry = {
    kind: 'decision',
    sourceType: 'Decision',
    visibility: 'thread',
    confidence: '',
    title: 'Key intelligence updated',
    body: bodyParts.join('\n\n') || 'Key intelligence fields updated.',
    people: [],
    occurredAt: new Date(),
    status: 'Open',
    createdBy: req.user._id,
    createdByEmail: req.user.email,
    createdAt: new Date()
  };
  await MeetingThread.updateOne({ _id: thread._id }, {
    $set: { keyDecisionsNeeded, keyGaps, keyQuestions, updatedAt: new Date() },
    $push: { entries: entry }
  });
  await writeAudit(req, 'THREAD_INTELLIGENCE_FIELDS_UPDATED', 'MeetingThread', thread._id, 'Updated key decisions, gaps and questions');
  return res.redirect('/user/threads/' + thread._id + '#diary-intelligence');
});


router.post('/threads/:id/health-override', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can adjust health judgement.');
  const score = Math.max(1, Math.min(10, Number(req.body.healthRating || req.body.healthScore || 0) || 6));
  const label = score <= 2 ? 'Critical' : score <= 4 ? 'At Risk' : score === 5 ? 'Watch' : score === 6 ? 'OK' : score <= 8 ? 'Good' : 'Strong';
  await MeetingThread.updateOne({ _id: thread._id }, { $set: {
    'ai.healthScore': score,
    'ai.healthLabel': label,
    'ai.healthUpdatedByEmail': req.user.email,
    'ai.healthUpdatedAt': new Date(),
    'ai.updatedAt': new Date(),
    updatedAt: new Date()
  } });
  await writeAudit(req, 'THREAD_HEALTH_OVERRIDE', 'MeetingThread', thread._id, `Health set to ${label} (${score}/10)`);
  return res.redirect('/user/threads/' + thread._id + '#metrics');
});

router.post('/threads/:id/entries/:entryId/update', requireUser, meetingFileUpload.array('files', 8), async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can update thread actions.');
  const allowedStatuses = ['Open','In Progress','Waiting','Done','Dropped','Blocked','Closed','Resolved',''];
  const status = allowedStatuses.includes(req.body.status) ? req.body.status : String(req.body.status || '').trim();
  const set = { updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) set['entries.$.status'] = status;
  if (Object.prototype.hasOwnProperty.call(req.body, 'ownerEmail')) set['entries.$.ownerEmail'] = String(req.body.ownerEmail || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(req.body, 'title')) set['entries.$.title'] = String(req.body.title || '').trim();
  if (Object.prototype.hasOwnProperty.call(req.body, 'body')) set['entries.$.body'] = String(req.body.body || '').trim();
  if (req.body.dueDate) set['entries.$.dueDate'] = new Date(req.body.dueDate);
  const uploadedFiles = (req.files || []).map(f => ({ originalName: f.originalname, fileName: f.filename, path: `/uploads/meeting-files/${f.filename}`, mimeType: f.mimetype, size: f.size, uploadedAt: new Date(), uploadedByEmail: req.user.email }));
  const updateDoc = { $set: set };
  if (uploadedFiles.length) updateDoc.$push = { 'entries.$.files': { $each: uploadedFiles } };
  await MeetingThread.updateOne({ _id: thread._id, 'entries._id': req.params.entryId }, updateDoc);
  await writeAudit(req, 'THREAD_ENTRY_UPDATED', 'MeetingThread', thread._id, 'Updated thread action/context entry');
  return res.redirect('/user/threads/' + thread._id + '#diary-intelligence');
});

router.post('/threads/:id/entry', requireUser, meetingFileUpload.array('files', 8), async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can add context to this thread.');
  const kind = ['note','call','generated_note','decision','risk','action','meeting','status'].includes(req.body.kind) ? req.body.kind : 'note';
  const rawBody = String(req.body.body || '').trim();
  const body = kind === 'generated_note' && rawBody ? `Clean note\n\n${rawBody.split(/\n+/).map(x=>x.trim()).filter(Boolean).map(x=>'• '+x.replace(/^[-•]\s*/, '')).join('\n')}` : rawBody;
  const uploadedFiles = (req.files || []).map(f => ({
    originalName: f.originalname,
    fileName: f.filename,
    path: `/uploads/meeting-files/${f.filename}`,
    mimeType: f.mimetype,
    size: f.size,
    uploadedAt: new Date(),
    uploadedByEmail: req.user.email
  }));
  const checklist = String(req.body.checklist || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(text => ({ text, done: false, createdAt: new Date() }));
  const entry = {
    kind,
    sourceType: sourceForKind(kind),
    visibility: ['private','thread','org'].includes(req.body.visibility) ? req.body.visibility : 'thread',
    confidence: ['','Low','Medium','High'].includes(req.body.confidence) ? req.body.confidence : '',
    title: String(req.body.title || '').trim(),
    body,
    checklist,
    people: parseCsvEmails(req.body.people || req.body.participants),
    occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
    ownerEmail: String(req.body.ownerEmail || '').trim().toLowerCase(),
    dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
    status: String(req.body.entryStatus || '').trim(),
    severity: ['Low','Medium','High','Critical'].includes(req.body.severity) ? req.body.severity : '',
    linkedTranscriptId: req.body.linkedTranscriptId || undefined,
    files: uploadedFiles,
    createdBy: req.user._id,
    createdByEmail: req.user.email,
    createdAt: new Date(),
  };
  if (!entry.title && !entry.body && !entry.checklist.length && !entry.files.length) return res.redirect('/user/threads/' + req.params.id);
  await MeetingThread.updateOne({ _id: thread._id }, { $push: { entries: entry }, $set: { updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_ENTRY_ADDED', 'MeetingThread', req.params.id, `Added ${kind} to thread`);
  return res.redirect('/user/threads/' + req.params.id);
});

router.post('/threads/:id/permissions', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canOwnThread(req, thread)) return res.status(403).send('Only the thread owner can change permissions.');
  const contributorEmails = parseCsvEmails(req.body.contributorEmails);
  const viewerEmails = parseCsvEmails(req.body.viewerEmails);
  const acl = uniqEmails([thread.ownerEmail, ...(getUserPrincipals(req.user)||[]), ...contributorEmails, ...viewerEmails]);
  await MeetingThread.updateOne({ _id: thread._id }, { $set: { contributorEmails, viewerEmails, memberEmails: uniqEmails([...contributorEmails, ...viewerEmails]), 'acl.allowedEmails': acl, 'acl.updatedAt': new Date(), updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_PERMISSIONS_UPDATED', 'MeetingThread', thread._id, 'Updated thread permissions');
  return res.redirect('/user/threads/' + thread._id);
});



router.post('/threads/:id/generate-insight', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can generate insight.');
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ subject: 1, startDateTime: 1, text: 1, 'ai.summary': 1, 'ai.detailedNotes': 1 })
    .sort({ startDateTime: -1 })
    .limit(12)
    .lean();
  try {
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.status': 'generating_insight', 'ai.updatedAt': new Date() } });
    const out = await generateThreadProgressSummary({ meetings, threadName: thread.name, objective: thread.objective, desiredOutcome: thread.desiredOutcome || '', status: thread.status, entries: thread.entries || [] });
    const insight = out.executiveMemory || out.progressSummary || '';
    const digest = digestFromThread(thread);
    await MeetingThread.updateOne({ _id: thread._id }, { $set: {
      'ai.status': 'done',
      'ai.model': out.model,
      'ai.insight': insight,
      'ai.insightGeneratedAt': new Date(),
      'ai.insightGeneratedBy': req.user._id,
      'ai.insightGeneratedByEmail': req.user.email,
      'ai.progressSummary': out.progressSummary || insight,
      'ai.executiveMemory': out.executiveMemory || insight,
      'ai.healthScore': out.healthScore || 0,
      'ai.healthLabel': out.healthLabel || '',
      'ai.confidence': out.confidence || '',
      'ai.suggestedStatus': out.suggestedStatus || '',
      'ai.error': '',
      'ai.lastAnalyzedAt': new Date(),
      'ai.updatedAt': new Date(),
      'dailyDigest.whatChanged': digest.whatChanged,
      'dailyDigest.openRisks': digest.openRisks,
      'dailyDigest.overdueActions': digest.overdueActions,
      'dailyDigest.attentionToday': digest.attentionToday,
      'dailyDigest.updatedAt': new Date(),
      updatedAt: new Date()
    } });
    await writeAudit(req, 'THREAD_INSIGHT_GENERATED', 'MeetingThread', thread._id, 'Generated thread insight from linked meetings and context');
  } catch (e) {
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.status': 'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() } });
  }
  return res.redirect('/user/threads/' + thread._id + '#insight');
});

router.post('/threads/:id/insight', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can edit insight.');
  const insight = String(req.body.insight || '').trim();
  await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.insight': insight, 'ai.insightEditedBy': req.user._id, 'ai.insightEditedByEmail': req.user.email, 'ai.insightEditedAt': new Date(), 'ai.updatedAt': new Date(), updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_INSIGHT_EDITED', 'MeetingThread', thread._id, 'Human-edited thread insight');
  return res.redirect('/user/threads/' + thread._id + '#insight');
});

router.post('/threads/:id/delete', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  const creatorOrOwner = canOwnThread(req, thread) || String(thread.createdBy || '') === String(req.user._id);
  if (!creatorOrOwner) return res.status(403).send('Only the creator/owner can delete this thread.');
  await MeetingThread.updateOne({ _id: thread._id }, { $set: { deletedAt: new Date(), deletedBy: req.user._id, updatedAt: new Date() } });
  await EventCache.updateMany({ orgId: req.user.org._id, linkedThreadId: thread._id }, { $set: { linkedThreadId: null, linkedThreadName: '' } });
  await writeAudit(req, 'THREAD_DELETED', 'MeetingThread', thread._id, 'Deleted outcome thread');
  return res.redirect('/user/threads');
});

router.post('/threads/:id/connect-recurring', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can connect recurring meetings.');
  const principals = getUserPrincipals(req.user);
  const requestedSubject = String(req.body.subject || '').trim();
  let subjectKey = normalizeSubjectKey(requestedSubject);
  if (!subjectKey && thread.meetingIds?.length) {
    const latest = await Transcript.findOne({ _id: { $in: thread.meetingIds }, orgId: req.user.org._id }).sort({ startDateTime: -1 }).select({ subject:1 }).lean();
    subjectKey = normalizeSubjectKey(latest?.subject || thread.name);
  }
  if (!subjectKey) subjectKey = normalizeSubjectKey(thread.name);
  const all = await Transcript.find({ orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1, acl:1 }).sort({ startDateTime: 1 }).limit(1000).lean();
  const matches = all.filter(m => normalizeSubjectKey(m.subject) === subjectKey || normalizeSubjectKey(m.subject).includes(subjectKey) || subjectKey.includes(normalizeSubjectKey(m.subject)));
  const ids = matches.map(m => m._id);
  const aclExtra = matches.flatMap(m => m.acl?.allowedEmails || []);
  const links = [];
  for (let i = 1; i < ids.length; i++) links.push({ fromTranscriptId: ids[i-1], toTranscriptId: ids[i], relation: 'same_recurring_chain', createdBy: req.user._id, createdAt: new Date() });
  await MeetingThread.updateOne({ _id: thread._id }, {
    $addToSet: { meetingIds: { $each: ids }, 'acl.allowedEmails': { $each: aclExtra }, links: { $each: links } },
    $set: { 'recurringChain.enabled': true, 'recurringChain.matchMode': 'subject', 'recurringChain.subjectKey': subjectKey, 'recurringChain.lastConnectedAt': new Date(), 'recurringChain.connectedCount': ids.length, 'acl.updatedAt': new Date(), updatedAt: new Date() }
  });
  await EventCache.updateMany({ orgId: req.user.org._id, subject: { $regex: subjectKey.split(' ').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*'), $options: 'i' } }, { $set: { linkedThreadId: thread._id, linkedThreadName: thread.name } });
  await writeAudit(req, 'THREAD_RECURRING_CHAIN_CONNECTED', 'MeetingThread', thread._id, `Connected recurring chain ${subjectKey}`);
  return res.redirect('/user/threads/' + thread._id);
});

router.post('/threads/:id/digest', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  const digest = digestFromThread(thread);
  await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'dailyDigest.whatChanged': digest.whatChanged, 'dailyDigest.openRisks': digest.openRisks, 'dailyDigest.overdueActions': digest.overdueActions, 'dailyDigest.attentionToday': digest.attentionToday, 'dailyDigest.updatedAt': new Date() } });
  return res.redirect('/user/threads/' + thread._id);
});

router.post('/threads/:id/link-meetings', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can link meetings.');
  const ids = Array.isArray(req.body.meetingIds) ? req.body.meetingIds : [req.body.meetingIds].filter(Boolean);
  const docs = await Transcript.find({ _id: { $in: ids }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).select({ _id:1, acl:1 }).lean();
  const aclExtra = docs.flatMap(m => m.acl?.allowedEmails || []);
  await MeetingThread.updateOne({ _id: thread._id }, { $addToSet: { meetingIds: { $each: docs.map(d => d._id) }, 'acl.allowedEmails': { $each: aclExtra } }, $set: { 'acl.updatedAt': new Date(), updatedAt: new Date() } });
  return res.redirect('/user/threads/' + req.params.id);
});

router.post('/threads/:id/analyze', requireUser, async (req, res) => {
  const principals = getUserPrincipals(req.user);
  const thread = await MeetingThread.findOne({ _id: req.params.id, orgId: req.user.org._id, deletedAt: null, $or: [{ 'acl.allowedEmails': { $in: principals } }, { ownerEmail: { $in: principals } }, { contributorEmails: { $in: principals } }, { viewerEmails: { $in: principals } }] });
  if (!thread) return res.status(404).send('Thread not found');
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } })
    .select({ subject: 1, startDateTime: 1, text: 1, 'ai.summary': 1, 'ai.detailedNotes': 1 })
    .sort({ startDateTime: 1 })
    .lean();
  try {
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.status': 'queued', 'ai.updatedAt': new Date() } });
    const out = await generateThreadProgressSummary({ meetings, threadName: thread.name, objective: thread.objective, desiredOutcome: '', status: thread.status, entries: thread.entries || [] });
    const digest = digestFromThread(thread);
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.status': 'done', 'ai.model': out.model, 'ai.progressSummary': out.progressSummary, 'ai.executiveMemory': out.executiveMemory || out.progressSummary, 'ai.healthScore': out.healthScore || 0, 'ai.healthLabel': out.healthLabel || '', 'ai.confidence': out.confidence || '', 'ai.suggestedStatus': out.suggestedStatus || '', 'ai.error': '', 'ai.lastAnalyzedAt': new Date(), 'ai.updatedAt': new Date(), 'dailyDigest.whatChanged': digest.whatChanged, 'dailyDigest.openRisks': digest.openRisks, 'dailyDigest.overdueActions': digest.overdueActions, 'dailyDigest.attentionToday': digest.attentionToday, 'dailyDigest.updatedAt': new Date() } });
  } catch (e) {
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'ai.status': 'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() } });
  }
  return res.redirect('/user/threads/' + thread._id);
});


async function accessibleTranscriptQueryForUser(req) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const me = String(req.user.email || '').toLowerCase().trim();
  const cacheRows = await EventCache.find({ orgId, userEmail: me, hasTranscript: true })
    .select({ eventId:1, transcripts:1 })
    .lean()
    .catch(()=>[]);
  const eventIds = [...new Set(cacheRows.map(e => String(e.eventId || '')).filter(Boolean))];
  const transcriptDocIds = [...new Set(cacheRows.flatMap(e => (e.transcripts || []).map(t => String(t.transcriptDocId || '')).filter(Boolean)))];
  const refOrs = cacheRows.flatMap(e => (e.transcripts || []).map(t => ({ meetingId: String(t.meetingId || ''), transcriptId: String(t.transcriptId || '') })).filter(x => x.meetingId || x.transcriptId));
  const ors = [
    { 'acl.allowedEmails': { $in: principals } },
    { participantEmails: { $in: principals } },
    ...(eventIds.length ? [{ eventId: { $in: eventIds } }] : []),
    ...(transcriptDocIds.length ? [{ _id: { $in: transcriptDocIds } }] : []),
    ...refOrs,
  ];
  return { orgId, principals, query: { orgId, $or: ors } };
}

// POST /user/chat/retrieve
// v2.2 intelligent retrieval: resolves latest/previous meetings automatically,
// ranks recurring meetings by intent + recency, and avoids unnecessary disambiguation.
router.post('/chat/retrieve', requireUser, ensureUserFreshToken, async (req, res) => {
  try {
    const qRaw = String(req.body?.query || '').trim();
    if (!qRaw) return res.status(400).json({ ok: false, error: 'query required' });

    const orgId = req.user.org._id;
    const principals = getUserPrincipals(req.user);

    const limitMeetings = Math.min(Number(req.body?.limitMeetings || 5), 15);
    const maxChunksPerMeeting = Math.min(Number(req.body?.chunksPerMeeting || 4), 8);
    const chunkFetchLimit = Math.min(Number(req.body?.chunkFetchLimit || 80), 250);

    const selectedTranscriptDocId = String(req.body?.selectedTranscriptDocId || '').trim();

    const access = await accessibleTranscriptQueryForUser(req);
    const allowedTranscripts = await Transcript.find(access.query)
      .select({ _id: 1, eventId: 1, meetingId: 1, transcriptId: 1, subject: 1, startDateTime: 1, endDateTime: 1, text: 1, vtt: 1, 'ai.summary': 1, 'ai.detailedNotes': 1, aiIndexStatus: 1, aiIndexedAt: 1 })
      .sort({ startDateTime: -1, createdAt: -1 })
      .limit(500)
      .lean();

    if (!allowedTranscripts.length) {
      return res.json({
        ok: true,
        query: qRaw,
        intent: classifyMeetingIntent(qRaw).intent,
        principals,
        allowedTranscriptCount: 0,
        meetings: [],
      });
    }

    const allowedIds = allowedTranscripts.map(t => t._id);
    let scopedAllowedIds = allowedIds;

    if (selectedTranscriptDocId) {
      const isAllowed = allowedIds.some(id => String(id) === selectedTranscriptDocId);
      if (!isAllowed) return res.status(403).json({ ok: false, error: 'Not allowed for this meeting' });
      scopedAllowedIds = [new mongoose.Types.ObjectId(selectedTranscriptDocId)];
    }

    const tMap = new Map(allowedTranscripts.map(t => [String(t._id), t]));
    const analysis = classifyMeetingIntent(qRaw);
    const queryTerms = importantTerms(qRaw);

    // v16.5: memory-note questions should not be hijacked by transcript fallback.
    // Return no meetings so /chat/answer uses the personal-note RAG path.
    if (!selectedTranscriptDocId && /\b(remember|remind|personal memory|my notes|notes I added|what.*remember)\b/i.test(qRaw)) {
      return res.json({ ok:true, query:qRaw, intent:'PERSONAL_MEMORY', mode:'personal-note-rag', principals, allowedTranscriptCount: allowedIds.length, returnedMeetings:0, meetings:[] });
    }

    function parseDate(d) {
      const x = new Date(d);
      return Number.isFinite(x.getTime()) ? x : null;
    }

    function norm(s) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    }

    function formatOptionLabel(m) {
      const dt = m.startDateTime ? new Date(m.startDateTime) : null;
      const dateStr = dt && !isNaN(dt.getTime())
        ? dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
        : (m.startDateTime || 'Unknown date');
      return `${m.subject || 'Meeting'} — ${dateStr}`;
    }

    function recencyScore(dt) {
      const d = parseDate(dt);
      if (!d) return 0;
      const days = Math.max(0, (Date.now() - d.getTime()) / 86400000);
      if (days <= 1) return 2.0;
      if (days <= 7) return 1.6;
      if (days <= 30) return 1.2;
      if (days <= 90) return 0.8;
      if (days <= 365) return 0.45;
      return 0.2;
    }

    function subjectScore(subject) {
      const s = norm(subject);
      if (!s) return 0;
      let score = 0;
      const sTokens = new Set(s.split(/\s+/).filter(Boolean));
      for (const term of queryTerms) {
        const nt = norm(term);
        if (!nt) continue;
        if (nt.length <= 3) { if (sTokens.has(nt)) score += 0.9; }
        else if (s.includes(nt)) score += 0.9;
        else if ([...sTokens].some(tok => tok.length >= 4 && (tok.includes(nt) || nt.includes(tok)))) score += 0.45;
      }
      const hint = norm(analysis.meetingTitleHint);
      if (hint) {
        if (s.includes(hint)) score += 4;
        else {
          const hintTerms = hint.split(/\s+/).filter(x => x.length >= 2);
          const hits = hintTerms.filter(x => s.includes(x)).length;
          if (hits) score += Math.min(3.5, hits * 0.9);
        }
      }
      return Math.min(score, 6);
    }

    function summaryScore(t) {
      const combined = norm(`${t?.ai?.summary || ''} ${t?.ai?.detailedNotes || ''}`);
      if (!combined) return 0;
      let score = 0;
      for (const term of queryTerms) if (combined.includes(term)) score += 0.25;
      return Math.min(score, 1.5);
    }

    // v11.2 progressive RAG backfill: older saved transcripts may not have chunks yet.
    // Build chunks only for likely matches/recent transcripts, so chat gets better over time
    // without blocking the whole calendar page.
    try {
      const likelyForChunking = allowedTranscripts
        .map(t => ({ t, score: subjectScore(t.subject) + summaryScore(t) + recencyScore(t.startDateTime) * 0.15 }))
        .filter(x => x.score > 0.25)
        .sort((a,b) => b.score - a.score)
        .slice(0, 12)
        .map(x => x.t);
      for (const t of likelyForChunking) {
        const full = t.text ? t : await Transcript.findById(t._id).select({ _id:1, orgId:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, text:1 }).lean();
        await ensureTranscriptChunksForDoc(full);
      }
    } catch (chunkErr) {
      console.warn('[chat/retrieve] progressive chunking skipped:', chunkErr.message || String(chunkErr));
    }

    // Direct meeting resolver for "previous/latest/last meeting" questions.
    // v3: if the user says "last weekly leadership meeting", do NOT pick the
    // latest meeting overall. First filter/rank by subject/topic, then by recency.
    if (!selectedTranscriptDocId && analysis.prefersLatest && (analysis.intent === 'MEETING_LOOKUP' || /\b(call|meeting)\b/i.test(qRaw))) {
      const hasTitleSignal = Boolean(analysis.meetingTitleHint) || queryTerms.length > 0;
      const candidates = allowedTranscripts
        .filter(t => parseDate(t.startDateTime))
        .map(t => {
          const coverage = v12TopicCoverageScore(qRaw, t);
          return {
            t,
            titleScore: subjectScore(t.subject) + summaryScore(t) + coverage.score,
            coverage,
            dt: parseDate(t.startDateTime),
          };
        })
        .filter(x => !hasTitleSignal || (x.coverage.ok && x.titleScore > 0))
        .sort((a, b) => {
          // v16.5 intelligence rule: when the user asks for latest/last/recent and
          // the topic/title matches, recency beats older meetings with richer text.
          // This fixes cases like “latest weekly leadership meeting” returning Feb/Apr.
          if (hasTitleSignal && analysis.prefersLatest) {
            const aStrong = (a.coverage.score >= 2 || a.titleScore >= 2) ? 1 : 0;
            const bStrong = (b.coverage.score >= 2 || b.titleScore >= 2) ? 1 : 0;
            if (bStrong !== aStrong) return bStrong - aStrong;
            return b.dt - a.dt;
          }
          if (hasTitleSignal && b.titleScore !== a.titleScore) return b.titleScore - a.titleScore;
          return b.dt - a.dt;
        });

      if (hasTitleSignal && !candidates.length) {
        // Last rescue: transcript/context text may contain the account name even if the title is odd.
        const textHits = allowedTranscripts
          .map(t => { const coverage = v12TopicCoverageScore(qRaw, t); return { t, coverage, score: coverage.score + summaryScore(t), dt: parseDate(t.startDateTime) }; })
          .filter(x => x.coverage.ok && x.score > 0 && x.dt)
          .sort((a,b) => (b.score - a.score) || (b.dt - a.dt));
        if (textHits.length) {
          const pickedText = textHits[0].t;
          return res.json({ ok:true, query:qRaw, intent:analysis.intent, mode:'text-aware-latest-meeting-resolver', principals, allowedTranscriptCount: allowedIds.length, returnedMeetings:1, meetings:[{ transcriptDocId:String(pickedText._id), subject:pickedText.subject||'Meeting', startDateTime:pickedText.startDateTime||'', meetingScore:900, topChunks:[], chunkCount:0, resolverNote:'Selected latest accessible transcript whose text/context matches the topic.' }] });
        }
        return res.json({ ok: true, query: qRaw, intent: analysis.intent, mode: 'no-topic-match', principals, allowedTranscriptCount: allowedIds.length, returnedMeetings: 0, meetings: [], message: 'No accessible meeting matched the topic/title in your question.' });
      }

      const picked = (candidates[0]?.t) || allowedTranscripts
        .filter(t => parseDate(t.startDateTime))
        .sort((a, b) => parseDate(b.startDateTime) - parseDate(a.startDateTime))[0] || allowedTranscripts[0];

      return res.json({
        ok: true,
        query: qRaw,
        intent: analysis.intent,
        mode: hasTitleSignal ? 'topic-aware-latest-meeting-resolver' : 'latest-meeting-resolver',
        principals,
        allowedTranscriptCount: allowedIds.length,
        returnedMeetings: picked ? 1 : 0,
        meetings: picked ? [{
          transcriptDocId: String(picked._id),
          subject: picked.subject || 'Meeting',
          startDateTime: picked.startDateTime || '',
          meetingScore: 999,
          topChunks: [],
          chunkCount: 0,
          resolverNote: hasTitleSignal
            ? 'Selected the latest accessible meeting matching the topic/title in your question.'
            : 'Selected the latest past meeting accessible to you.',
        }] : [],
      });
    }

    // Candidate chunks from transcript text. For summary/action questions, text search may be weak,
    // so we combine text evidence with subject/recency intelligence below.
    let chunks = [];
    let mode = 'text';
    try {
      chunks = await TranscriptChunk.find(
        {
          orgId,
          transcriptDocId: { $in: scopedAllowedIds },
          $text: { $search: qRaw },
        },
        {
          score: { $meta: 'textScore' },
          transcriptDocId: 1,
          chunkIndex: 1,
          text: 1,
          subject: 1,
          startDateTime: 1,
        }
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(chunkFetchLimit)
        .lean();
    } catch (e) {
      mode = 'regex';
      const ors = queryTerms.slice(0, 8).map(term => ({ text: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }));
      chunks = ors.length
        ? await TranscriptChunk.find({ orgId, transcriptDocId: { $in: scopedAllowedIds }, $or: ors })
            .select({ transcriptDocId: 1, chunkIndex: 1, text: 1, subject: 1, startDateTime: 1 })
            .limit(chunkFetchLimit)
            .lean()
        : [];
    }

    const grouped = new Map();
    for (const t of allowedTranscripts) {
      if (!scopedAllowedIds.some(id => String(id) === String(t._id))) continue;
      const ss = subjectScore(t.subject);
      const sm = summaryScore(t);
      const rs = recencyScore(t.startDateTime);
      // Preload meetings that match title/topic even when chunk search is empty.
      if (selectedTranscriptDocId || ss > 0 || sm > 0 || (analysis.prefersLatest && ss > 0)) {
        grouped.set(String(t._id), {
          transcriptDocId: String(t._id),
          subject: t.subject || 'Meeting',
          startDateTime: t.startDateTime || '',
          meetingScore: ss + sm + (analysis.prefersLatest ? rs * 1.25 : rs * 0.35),
          chunks: [],
        });
      }
    }

    for (const c of chunks) {
      const tid = String(c.transcriptDocId);
      const t = tMap.get(tid);
      if (!t) continue;
      const meeting = grouped.get(tid) || {
        transcriptDocId: tid,
        subject: t.subject || c.subject || 'Meeting',
        startDateTime: t.startDateTime || c.startDateTime || '',
        meetingScore: 0,
        chunks: [],
      };
      const baseChunkScore = (typeof c.score === 'number') ? c.score : 1;
      meeting.chunks.push({
        chunkIndex: c.chunkIndex,
        chunkScore: baseChunkScore,
        preview: String(c.text || '').slice(0, 900),
      });
      grouped.set(tid, meeting);
    }

    // If still empty, fall back to latest accessible meetings.
    if (!grouped.size) {
      for (const t of allowedTranscripts.slice(0, limitMeetings)) {
        grouped.set(String(t._id), {
          transcriptDocId: String(t._id),
          subject: t.subject || 'Meeting',
          startDateTime: t.startDateTime || '',
          meetingScore: recencyScore(t.startDateTime),
          chunks: [],
        });
      }
      mode = 'latest-fallback';
    }

    const meetings = Array.from(grouped.values()).map(m => {
      m.chunks.sort((a, b) => (b.chunkScore || 0) - (a.chunkScore || 0));
      const topChunks = m.chunks.slice(0, maxChunksPerMeeting);
      const chunkEvidence = topChunks.reduce((s, x) => s + (x.chunkScore || 0), 0);
      const t = tMap.get(String(m.transcriptDocId));
      m.meetingScore += chunkEvidence + subjectScore(m.subject) + summaryScore(t) + (analysis.prefersLatest ? recencyScore(m.startDateTime) : recencyScore(m.startDateTime) * 0.4);
      return {
        transcriptDocId: m.transcriptDocId,
        subject: m.subject,
        startDateTime: m.startDateTime,
        meetingScore: m.meetingScore,
        topChunks,
        chunkCount: m.chunks.length,
        label: formatOptionLabel(m),
      };
    });

    meetings.sort((a, b) => (b.meetingScore || 0) - (a.meetingScore || 0));

    // v2.2 rule: do NOT interrupt with "which meeting?" for recurring titles.
    // Pick the best/latest match and let answer cite sources. The UI can still expose sources.
    return res.json({
      ok: true,
      query: qRaw,
      intent: analysis.intent,
      mode,
      principals,
      allowedTranscriptCount: allowedIds.length,
      returnedMeetings: Math.min(meetings.length, limitMeetings),
      autoResolved: meetings.length > 1,
      resolverNote: meetings.length > 1
        ? `Auto-selected the best match first: ${meetings[0].label}. Other close matches are available in sources.`
        : '',
      meetings: meetings.slice(0, limitMeetings),
    });
  } catch (e) {
    console.error('[chat/retrieve] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'server error' });
  }
});


function v12StrongTopicTerms(qRaw) {
  const baseStop = new Set(['what','was','were','the','and','for','from','with','about','that','this','there','their','your','you','our','meeting','meetings','summary','summarize','action','actions','items','item','decision','decisions','risk','risks','previous','last','latest','recent','my','me','in','on','of','to','a','an','is','are','did','do','does','can','could','would','should','update','discussed','call','calls']);
  const raw = String(qRaw || '');
  const terms = raw
    .replace(/&/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => x.length >= 3 && !baseStop.has(x.toLowerCase()));
  return [...new Set(terms.map(x => x.toLowerCase()))].slice(0, 8);
}
function v12WordTokens(s) {
  return String(s || '').toLowerCase().replace(/&/g,' ').replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
}
function v12TopicCoverageScore(qRaw, doc) {
  const strong = v12StrongTopicTerms(qRaw);
  if (!strong.length) return { score: 0, required: 0, hit: 0, ok: true };
  const title = v12WordTokens(doc?.subject || '');
  const summary = v12WordTokens(`${doc?.ai?.summary || ''} ${doc?.ai?.detailedNotes || ''}`).slice(0, 500);
  const text = v12WordTokens(String(doc?.text || doc?.vtt || '').slice(0, 12000));
  const titleSet = new Set(title), summarySet = new Set(summary), textSet = new Set(text);
  let score = 0, hit = 0;
  for (const term of strong) {
    const titleHit = titleSet.has(term) || title.some(tok => tok.length >= 5 && (tok.includes(term) || term.includes(tok)));
    const summaryHit = summarySet.has(term);
    const textHit = textSet.has(term);
    if (titleHit) { score += 4; hit++; }
    else if (summaryHit) { score += 2; hit++; }
    else if (textHit) { score += 1; hit++; }
  }
  const required = strong.length >= 2 ? Math.min(2, strong.length) : 1;
  return { score, required, hit, ok: hit >= required };
}

function importantTerms(qRaw) {
  const stop = new Set(['what','was','were','the','and','for','from','with','about','that','this','there','their','your','you','our','meeting','meetings','summary','summarize','action','actions','items','item','decision','decisions','risk','risks','previous','last','latest','my','me','in','on','of','to','a','an','is','are','did','do','does','can','could','would','should']);
  return String(qRaw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && !stop.has(x))
    .slice(0, 12);
}

function classifyMeetingIntent(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  let intent = 'GENERAL_SEARCH';
  if (/\b(previous|last|latest|recent)\b.*\b(meeting|call)\b|\bmy previous (meeting|call)\b|\bmy last (meeting|call)\b/.test(q)) intent = 'MEETING_LOOKUP';
  else if (/\b(action|actions|action items|todo|follow up|follow-up|next steps)\b/.test(q)) intent = 'ACTION_ITEMS';
  else if (/\b(decision|decisions|decided|agreed)\b/.test(q)) intent = 'DECISIONS';
  else if (/\b(risk|risks|blocker|blockers|dependency|dependencies)\b/.test(q)) intent = 'RISKS';
  else if (/\b(summary|summarize|recap|minutes|notes)\b/.test(q)) intent = 'SUMMARY';
  else if (/\b(who said|what did .* say|mentioned by|speaker)\b/.test(q)) intent = 'WHO_SAID_WHAT';

  let meetingTitleHint = '';
  const m = qRaw.match(/(?:of|for|from|about)\s+(?:the\s+)?(.+?)(?:\?|$)/i)
    || qRaw.match(/(?:latest|last|recent|previous)\s+(.+?)\s+(?:meeting|call)\b/i)
    || qRaw.match(/(?:meeting|call)\s+(?:called|named)\s+(.+?)(?:\?|$)/i);
  if (m && m[1]) {
    meetingTitleHint = m[1]
      .replace(/\b(summary|summarize|recap|minutes|notes|meeting|call|previous|last|latest|recent|update|discussed)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    intent,
    meetingTitleHint,
    prefersLatest: intent === 'MEETING_LOOKUP' || /\b(previous|last|latest|recent)\b/.test(q),
  };
}

// POST /user/chat/answer
// Answers ONLY from transcript chunks the signed-in user is allowed to access.
// Supports one selected transcript or multiple retrieved previous transcripts.
function isChiefOfStaffFocusQuery(query) {
  return /\b(what\s+should\s+be\s+my\s+focus|focus\s+for\s+today|focus\s+today|chief\s+of\s+staff|cos\s+brief|daily\s+brief|what\s+needs\s+my\s+attention|what\s+should\s+i\s+prioriti[sz]e|priorities\s+today|prepare\s+me\s+for\s+today)\b/i.test(String(query || ''));
}
function formatEvidenceDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return 'Unknown';
  return d.toLocaleString('en-IN', { weekday:'short', day:'2-digit', month:'short', hour:'numeric', minute:'2-digit', hour12:true });
}
function deterministicChiefOfStaffBrief({ meetings, actions, contexts, threads }) {
  const lines = [];
  const meetingList = Array.isArray(meetings) ? meetings : [];
  const actionList = Array.isArray(actions) ? actions : [];
  const ctxList = Array.isArray(contexts) ? contexts : [];
  const threadList = Array.isArray(threads) ? threads : [];
  const overdue = actionList.filter(a => a.dueDateISO && new Date(a.dueDateISO) < startOfDay(new Date()) && !/done|dropped/i.test(a.status || ''));
  const high = actionList.filter(a => /high|critical/i.test(a.priority || '') && !/done|dropped/i.test(a.status || ''));
  lines.push('### Chief-of-Staff Brief');
  const lead = [];
  if (meetingList.length) lead.push(`${meetingList.length} meeting(s) today`);
  if (overdue.length) lead.push(`${overdue.length} overdue action(s)`);
  if (high.length) lead.push(`${high.length} high-priority action(s)`);
  if (threadList.length) lead.push(`${threadList.length} active/at-risk thread(s)`);
  lines.push(lead.length ? `Your attention should go to ${lead.join(', ')}. I have prioritized items with concrete meeting/action/thread evidence instead of listing everything.` : 'I do not see enough strong evidence to create a decisive focus list yet. Load transcripts or add context to today’s meetings.');
  lines.push('');
  lines.push('### Your Focus Today');
  let n = 1;
  for (const a of [...overdue, ...high].slice(0,3)) {
    lines.push(`${n++}. **${a.title || 'Action item'}** — ${a.ownerName ? `Owner: ${a.ownerName}. ` : ''}${a.dueDate ? `Due: ${a.dueDate}. ` : ''}${a.meetingSubject ? `Anchor: ${a.meetingSubject}. ` : ''}${a.evidence ? `Evidence: ${a.evidence}` : 'Check status and unblock if needed.'}`);
  }
  for (const m of meetingList.slice(0, Math.max(0, 5-(n-1)))) {
    const linked = ctxList.filter(c => c.eventId && m.eventId && String(c.eventId) === String(m.eventId));
    const angle = linked[0]?.contextText || m.ai?.summary || m.ai?.detailedNotes || '';
    lines.push(`${n++}. **${m.subject || 'Meeting'}** — ${formatEvidenceDate(m.startDateTime)}. ${angle ? shortPrepText(angle, 240) : 'No linked context yet; ask for concrete decisions, owners and risks during the meeting.'}`);
  }
  if (n === 1) lines.push('- No strong action or meeting priority was found from current evidence.');
  lines.push('');
  lines.push('### Meetings to Prepare For');
  if (meetingList.length) meetingList.slice(0,6).forEach(m => lines.push(`- ${m.subject || 'Meeting'} — ${formatEvidenceDate(m.startDateTime)}${m.linkedThreadName ? ` — linked thread: ${m.linkedThreadName}` : ''}`)); else lines.push('- None found for today.');
  lines.push('');
  lines.push('### Decisions / Escalations Needed');
  const riskyThreads = threadList.filter(t => /risk|block/i.test(t.status || '')).slice(0,4);
  if (riskyThreads.length) riskyThreads.forEach(t => lines.push(`- ${t.name} — status is ${t.status}; ${t.ai?.suggestedStatus ? `AI suggested ${t.ai.suggestedStatus}.` : 'needs owner review.'}`)); else lines.push('- None clearly visible from current evidence.');
  lines.push('');
  lines.push('### Risks to Watch');
  const riskCtx = ctxList.filter(c => /risk|block|delay|stuck|dependency|unclear/i.test(`${c.title || ''} ${c.contextText || ''}`)).slice(0,4);
  if (riskCtx.length) riskCtx.forEach(c => lines.push(`- ${c.title || c.sourceType || 'Context'} — ${shortPrepText(c.contextText || c.fileText || '', 220)}`)); else lines.push('- None clearly visible from current evidence.');
  lines.push('');
  lines.push('Confidence: Medium.');
  return lines.join('\n');
}
async function buildChiefOfStaffBriefForUser(req, query, routedIntent = { intent: 'executive_briefing' }) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const tomorrowEnd = endOfDay(addDays(now, 1));
  const eventAccess = { orgId, userEmail: { $in: principals } };
  const meetings = await EventCache.find({ ...eventAccess, startDateTime: { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(20).lean();
  const actions = await ActionItem.find({ orgId, status: { $nin: ['Done','Dropped'] }, $or: [{ ownerEmail: { $in: principals } }, { assignedByEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }] }).sort({ dueDateISO: 1, meetingStartDateTime: -1, createdAt: -1 }).limit(40).lean();
  const contexts = await MeetingContext.find({ orgId, noteStatus: { $ne: 'archived' }, $or: [{ addedByEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }, { visibility: 'org' }] }).sort({ occurredAt: -1, createdAt: -1 }).limit(35).lean();
  const threads = await MeetingThread.find({ orgId, deletedAt: null, status: { $in: ['Active','At Risk','Blocked'] }, $or: [{ ownerEmail: { $in: principals } }, { contributorEmails: { $in: principals } }, { viewerEmails: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }] }).sort({ updatedAt: -1 }).limit(12).lean();
  const signals = buildExecutiveSignals({ meetings, actions, contexts, threads });
  const evidence = [];
  evidence.push(`ROUTED INTENT: ${routedIntent.intent || 'executive_briefing'} (${routedIntent.confidence || ''})`);
  evidence.push('EXECUTIVE RANKED MEETINGS TODAY');
  for (const m of signals.rankedMeetings.slice(0,15)) evidence.push(`- score:${m.executiveScore} | ${m.subject || 'Meeting'} | ${formatEvidenceDate(m.startDateTime)} | transcript:${m.hasTranscript ? 'yes' : 'no'} | AI:${m.aiIndexStatus || 'unknown'} | linkedThread:${m.linkedThreadName || ''} | linkedContext:${(m.linkedContexts||[]).length} | linkedActions:${(m.linkedActions||[]).length}`);
  evidence.push('\nEXECUTIVE RANKED OPEN ACTIONS');
  for (const a of signals.rankedActions.slice(0,25)) evidence.push(`- score:${a.executiveScore} | ${a.title || 'Action'} | owner:${a.ownerName || a.ownerEmail || 'Unassigned'} | due:${a.dueDate || a.dueDateISO || 'Unclear'} | priority:${a.priority || 'Unclear'} | status:${a.status || 'Open'} | meeting:${a.meetingSubject || ''} | evidence:${a.evidence || a.description || ''}`);
  evidence.push('\nSILENT RISKS DETECTED');
  for (const r of signals.silentRisks) evidence.push(`- ${r}`);
  evidence.push('\nRECENT CONTEXT / NOTES / MEMORY');
  for (const c of contexts.slice(0,24)) evidence.push(`- ${c.title || c.sourceType || 'Context'} | type:${c.sourceType || c.contextType || ''} | people:${(c.people || []).join(', ')} | when:${formatEvidenceDate(c.occurredAt || c.createdAt)} | text:${shortPrepText(c.contextText || c.fileText || '', 700)}`);
  evidence.push('\nEXECUTIVE RANKED ACTIVE THREADS');
  for (const t of signals.rankedThreads.slice(0,12)) evidence.push(`- score:${t.executiveScore} | ${t.name} | status:${t.status} | owner:${t.ownerEmail || ''} | outcome:${t.objective || t.desiredOutcome || ''} | AI:${shortPrepText(t.ai?.executiveMemory || t.ai?.progressSummary || '', 700)}`);
  if (process.env.OPENAI_API_KEY) {
    try {
      const { answer, model } = await generateChiefOfStaffBrief({ question: query, context: evidence.join('\n'), dateLabel: 'today' });
      return { answer, model, sources: meetings.slice(0,8).map(m => ({ subject: m.subject || 'Meeting', startDateTime: m.startDateTime || '', meetingScore: m.executiveScore || m.meetingScore || 0, match: 'executive-brief' })) };
    } catch (e) {
      console.warn('[chief-of-staff-brief] AI failed, using deterministic brief:', e.message || String(e));
    }
  }
  return { answer: deterministicChiefOfStaffBrief({ meetings: signals.rankedMeetings || meetings, actions: signals.rankedActions || actions, contexts, threads: signals.rankedThreads || threads }), model: 'deterministic-chief-of-staff-v17.2', sources: meetings.slice(0,8).map(m => ({ subject: m.subject || 'Meeting', startDateTime: m.startDateTime || '', meetingScore: m.executiveScore || m.meetingScore || 0, match: 'executive-brief' })) };
}


// v17.2 Executive Intelligence Engine
// Deterministic router prevents "focus today" from being mistaken for action assignment.
function classifyExecutiveIntent(query) {
  const q = String(query || '').toLowerCase().replace(/[^a-z0-9\s&|:-]/g, ' ');
  const norm = q.replace(/\s+/g, ' ').trim();
  if (!norm) return { intent: 'empty', confidence: 0 };

  const focusRx = /\b(focus|prioritise|prioritize|attention|chief of staff|cos brief|daily brief|leadership brief|what matters|what should i do|what should be my focus|pressure today|risks today|today's brief|today brief)\b/;
  const prepRx = /\b(prep|prepare|preparation|follow up context|before meeting|what should i ask|what should i focus on in)\b/;
  const actionRx = /(^|\b)(assign|create|add|make|log)\b.{0,50}\b(action item|follow up|todo|task)\b|^action\s*:/;
  const noteRx = /(^|\b)(create|add|capture|log|make)\b.{0,50}\b(note|call note|meeting note|manual meeting|personal note)\b|^note\s*:/;
  const memoryRx = /\b(remember that|add to memory|memory note|learn this|team structure|employee alias|org memory)\b/;
  const escalationRx = /\b(escalat|slipping|silent risk|blocker|blocked|at risk|what is stuck|what is delayed)\b/;

  // Highest precedence: executive questions and risk/briefing questions.
  if (focusRx.test(norm) || (/\btoday\b/.test(norm) && /\b(should|need|attention|priority|priorities|focus)\b/.test(norm))) return { intent: 'executive_briefing', confidence: 0.98 };
  if (escalationRx.test(norm) && !actionRx.test(norm)) return { intent: 'escalation_analysis', confidence: 0.9 };
  if (prepRx.test(norm) && !actionRx.test(norm)) return { intent: 'preparation_brief', confidence: 0.86 };
  if (actionRx.test(norm)) return { intent: 'action_assignment', confidence: 0.9 };
  if (noteRx.test(norm)) return { intent: 'note_capture', confidence: 0.9 };
  if (memoryRx.test(norm)) return { intent: 'memory_management', confidence: 0.82 };
  return { intent: 'knowledge_answer', confidence: 0.55 };
}

function executiveKeywordScore(text) {
  const t = String(text || '').toLowerCase();
  const weights = [
    ['urgent', 12], ['blocked', 14], ['blocker', 14], ['pending', 8], ['dependency', 10],
    ['escalation', 14], ['release', 10], ['production', 12], ['migration', 10], ['risk', 9],
    ['delay', 10], ['slip', 12], ['stuck', 12], ['decision', 7], ['clarification', 7],
    ['client', 5], ['readiness', 8], ['issue', 5], ['failed', 9], ['ownership', 7]
  ];
  return weights.reduce((score, [word, weight]) => score + (t.includes(word) ? weight : 0), 0);
}

function daysSince(value) {
  const d = value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return 999;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function scoreExecutiveMeeting(meeting, linkedContexts = [], linkedActions = [], linkedThread = null) {
  const haystack = [
    meeting?.subject, meeting?.linkedThreadName,
    ...(linkedContexts || []).map(c => `${c.title || ''} ${c.contextText || ''} ${c.fileText || ''}`),
    ...(linkedActions || []).map(a => `${a.title || ''} ${a.description || ''} ${a.evidence || ''}`),
    linkedThread ? `${linkedThread.name || ''} ${linkedThread.objective || ''} ${linkedThread.ai?.executiveMemory || ''} ${linkedThread.status || ''}` : ''
  ].join(' ');
  let score = 20 + executiveKeywordScore(haystack);
  if (meeting?.hasTranscript) score += 6;
  if (meeting?.linkedThreadId || meeting?.linkedThreadName) score += 10;
  if (linkedContexts.length) score += Math.min(24, linkedContexts.length * 8);
  if (linkedActions.length) score += Math.min(30, linkedActions.length * 10);
  if (linkedThread && /risk|blocked/i.test(linkedThread.status || '')) score += 24;
  if (/leadership|ceo|audit|release|delivery|review|customer|client|architecture|platform/i.test(meeting?.subject || '')) score += 8;
  return score;
}

function scoreExecutiveAction(action) {
  let score = 10 + executiveKeywordScore(`${action?.title || ''} ${action?.description || ''} ${action?.evidence || ''} ${action?.meetingSubject || ''}`);
  if (/high|critical/i.test(action?.priority || '')) score += 24;
  if (action?.dueDateISO) {
    const due = new Date(action.dueDateISO);
    if (Number.isFinite(due.getTime())) {
      const diffDays = Math.ceil((due.getTime() - Date.now()) / 86400000);
      if (diffDays < 0) score += 32;
      else if (diffDays <= 1) score += 20;
      else if (diffDays <= 3) score += 10;
    }
  }
  if (!action?.ownerEmail && /unassigned/i.test(action?.ownerName || '')) score += 10;
  if (daysSince(action?.updatedAt || action?.createdAt) > 5) score += 8;
  return score;
}

function scoreExecutiveThread(thread) {
  let score = 12 + executiveKeywordScore(`${thread?.name || ''} ${thread?.objective || ''} ${thread?.ai?.executiveMemory || ''} ${thread?.ai?.progressSummary || ''}`);
  if (/blocked/i.test(thread?.status || '')) score += 40;
  else if (/risk/i.test(thread?.status || '')) score += 28;
  else if (/active/i.test(thread?.status || '')) score += 8;
  const entries = Array.isArray(thread?.entries) ? thread.entries : [];
  score += Math.min(30, entries.filter(e => e.kind === 'risk').length * 8);
  score += Math.min(30, entries.filter(e => e.kind === 'action' && !/done|closed|complete/i.test(e.status || '')).length * 6);
  if (thread?.recurringChain?.enabled) score += 8;
  if (daysSince(thread?.updatedAt) > 7) score += 6;
  return score;
}

function buildExecutiveSignals({ meetings, actions, contexts, threads }) {
  const actionsByEvent = new Map();
  for (const a of actions || []) {
    const k = String(a.eventId || '');
    if (!k) continue;
    if (!actionsByEvent.has(k)) actionsByEvent.set(k, []);
    actionsByEvent.get(k).push(a);
  }
  const contextsByEvent = new Map();
  for (const c of contexts || []) {
    const k = String(c.eventId || '');
    if (!k) continue;
    if (!contextsByEvent.has(k)) contextsByEvent.set(k, []);
    contextsByEvent.get(k).push(c);
  }
  const threadByName = new Map((threads || []).map(t => [String(t.name || '').toLowerCase(), t]));
  const rankedMeetings = (meetings || []).map(m => {
    const linkedContexts = contextsByEvent.get(String(m.eventId || '')) || [];
    const linkedActions = actionsByEvent.get(String(m.eventId || '')) || [];
    const linkedThread = threadByName.get(String(m.linkedThreadName || '').toLowerCase()) || null;
    return { ...m, executiveScore: scoreExecutiveMeeting(m, linkedContexts, linkedActions, linkedThread), linkedContexts, linkedActions, linkedThread };
  }).sort((a,b) => b.executiveScore - a.executiveScore || new Date(a.startDateTime || 0) - new Date(b.startDateTime || 0));
  const rankedActions = (actions || []).map(a => ({ ...a, executiveScore: scoreExecutiveAction(a) })).sort((a,b) => b.executiveScore - a.executiveScore);
  const rankedThreads = (threads || []).map(t => ({ ...t, executiveScore: scoreExecutiveThread(t) })).sort((a,b) => b.executiveScore - a.executiveScore);
  const silentRisks = [];
  for (const t of rankedThreads.slice(0,8)) {
    const riskEntries = (t.entries || []).filter(e => e.kind === 'risk' && !/done|closed|resolved/i.test(e.status || ''));
    const openActions = (t.entries || []).filter(e => e.kind === 'action' && !/done|closed|complete/i.test(e.status || ''));
    if (/risk|blocked/i.test(t.status || '') || riskEntries.length || openActions.length >= 3) {
      silentRisks.push(`${t.name}: ${t.status || 'Active'}; ${riskEntries.length} risk(s), ${openActions.length} open thread action(s).`);
    }
  }
  for (const a of rankedActions.slice(0,12)) {
    if (a.dueDateISO && new Date(a.dueDateISO) < startOfDay(new Date()) && !/done|dropped/i.test(a.status || '')) {
      silentRisks.push(`Overdue action: ${a.title} (${a.ownerName || a.ownerEmail || 'Unassigned'}, due ${a.dueDate || a.dueDateISO}).`);
    }
  }
  return { rankedMeetings, rankedActions, rankedThreads, silentRisks: [...new Set(silentRisks)].slice(0,10) };
}




// v23.4: Intent-aware meeting copilot retrieval.
// It resolves intent + meeting + time BEFORE any global retrieval. If a meeting is
// detected, Kili must not use unrelated meetings like Weekly Leadership Call or
// X Connect Pending Items for a Daily Call with NK question.
function normalizeMeetingTitleV234(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(ms teams|microsoft teams|teams meeting|zoom|meet|meeting|call|sync|review|catch.?up|catchup|discussion|session)\b/g, ' ')
    .replace(/\b(tomorrow|today|yesterday|latest|last|previous|next|what|happened|discussed|summary|summarize|prepare|prep|plan|items|agenda|should|i|we|my|our|for|with|in|on|the|a|an|sir)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function titleTokensV234(value) {
  return normalizeMeetingTitleV234(value).split(/\s+/).filter(x => x && x.length >= 2);
}
function classifyMeetingIntentV234(query) {
  const q = String(query || '').toLowerCase();
  const looksMeeting = /\b(meeting|call|review|sync|daily|weekly|monthly|nk|sir)\b/i.test(q);
  if (!looksMeeting) return { intent:'none', dateMode:'none' };
  if (/\b(tomorrow|next)\b/i.test(q) || /\b(prep|prepare|plan|agenda|talking points|what should i ask|what should i cover|items.*for)\b/i.test(q)) return { intent:'PREP_NEXT', dateMode:'tomorrow' };
  if (/\b(today|today's)\b/i.test(q)) return { intent:'SUMMARY_TODAY', dateMode:'today' };
  if (/\b(yesterday|yesterday's)\b/i.test(q)) return { intent:'SUMMARY_YESTERDAY', dateMode:'yesterday' };
  if (/\b(what happened|discussed|summary|summarize|recap|minutes|what was)\b/i.test(q)) return { intent:'SUMMARY_LAST', dateMode:'latest' };
  return { intent:'THREAD_OVERVIEW', dateMode:'latest' };
}
function extractMeetingHintV234(query) {
  const q = String(query || '').trim();
  const patterns = [
    /\b(?:for|before|in)\s+(.+?)\s+(?:tomorrow|today|yesterday|next|on\b|\?|$)/i,
    /\b(?:what\s+happened\s+in|what\s+happened\s+on|what\s+was\s+discussed\s+in|summari[sz]e|recap)\s+(.+?)(?:\?|$)/i,
    /\b(?:plan|prepare|prep)\s+(?:for\s+)?(.+?)(?:\?|$)/i,
    /\b(?:items|agenda|talking points)\s+(?:for\s+)?(.+?)(?:\?|$)/i,
  ];
  for (const rx of patterns) {
    const m = q.match(rx);
    if (m && m[1]) {
      const h = m[1].replace(/\b(i|we|should|what|is|are|the|items|to|for|tomorrow|today|yesterday)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      if (h) return h;
    }
  }
  return q;
}
function meetingTitleScoreV234(hintOrQuery, subject) {
  const qTokens = titleTokensV234(hintOrQuery);
  const sTokens = titleTokensV234(subject);
  if (!qTokens.length || !sTokens.length) return 0;
  let score = 0;
  for (const qt of qTokens) {
    if (sTokens.includes(qt)) score += qt.length <= 3 ? 8 : 6;
    else if (qt.length >= 3 && sTokens.some(st => st.includes(qt) || qt.includes(st))) score += 2;
  }
  const qs = normalizeMeetingTitleV234(hintOrQuery);
  const ss = normalizeMeetingTitleV234(subject);
  if (qs && ss && (ss.includes(qs) || qs.includes(ss))) score += 14;
  return score;
}
function isStrictMeetingTitleMatchV234(hintOrQuery, subject) {
  const qTokens = titleTokensV234(hintOrQuery);
  const sTokens = titleTokensV234(subject);
  if (!qTokens.length || !sTokens.length) return false;
  // Very short executive aliases like NK must be treated as hard anchors.
  const hardAnchors = qTokens.filter(t => t.length <= 3 || ['nk','ceo','cfo','cto'].includes(t));
  if (hardAnchors.length && !hardAnchors.every(t => sTokens.includes(t))) return false;
  const meaningful = qTokens.filter(t => !['daily','weekly','monthly'].includes(t));
  const overlap = meaningful.filter(t => sTokens.includes(t) || sTokens.some(st => st.includes(t) || t.includes(st))).length;
  return overlap >= Math.min(meaningful.length, hardAnchors.length ? 1 : 2);
}
function meetingDateWindowV234(dateMode) {
  const now = new Date();
  if (dateMode === 'today') return { from:startOfDay(now), to:endOfDay(now) };
  if (dateMode === 'yesterday') return { from:startOfDay(addDays(now, -1)), to:endOfDay(addDays(now, -1)) };
  if (dateMode === 'tomorrow') return { from:startOfDay(addDays(now, 1)), to:endOfDay(addDays(now, 1)) };
  return null;
}
function deterministicMeetingAnswerV234({ query, intent, target, transcripts }) {
  const latest = transcripts && transcripts[0];
  const subject = (target?.subject || latest?.subject || 'the meeting');
  const lines = [];
  if (intent === 'PREP_NEXT') {
    lines.push(`### Executive Prep for ${subject}`);
    const text = transcripts.map(t => `${t.ai?.summary || ''}\n${t.ai?.detailedNotes || ''}`).join('\n').toLowerCase();
    const cues = [];
    if (/block|delay|stuck|risk|issue/.test(text)) cues.push('Focus on open blockers and delays explicitly discussed in the previous instances.');
    if (/action|owner|follow/.test(text)) cues.push('Clarify owners and carry-forward actions from the last call.');
    if (/decision|approve|confirm/.test(text)) cues.push('Push for decisions that were left open.');
    if (/client|release|defect|bug/.test(text)) cues.push('Confirm whether client/release/defect topics have changed since the last call.');
    (cues.length ? cues : ['Review the last matched occurrence and carry forward only unresolved points from that same meeting thread.']).slice(0,5).forEach(x => lines.push(`- ${x}`));
    lines.push('\n### Sources Used');
    transcripts.slice(0,5).forEach(t => lines.push(`- ${t.subject || 'Meeting'} — ${t.startDateTime || ''}`));
    lines.push('\nConfidence: Medium.');
    return lines.join('\n');
  }
  lines.push(`### ${intent === 'SUMMARY_TODAY' ? 'Today\'s' : intent === 'SUMMARY_YESTERDAY' ? 'Yesterday\'s' : 'Latest'} ${subject}`);
  if (!latest) return `I could not find a matching ${subject} occurrence in the requested time window.`;
  lines.push(latest.ai?.summary || latest.ai?.detailedNotes || 'I found the meeting, but no AI notes/transcript text were available yet.');
  lines.push('\n### Source Used');
  lines.push(`- ${latest.subject || 'Meeting'} — ${latest.startDateTime || ''}`);
  lines.push('\nConfidence: Medium.');
  return lines.join('\n');
}
async function answerIntentAwareMeetingV234(req, query) {
  const routed = classifyMeetingIntentV234(query);
  if (routed.intent === 'none') return null;
  const hint = extractMeetingHintV234(query);
  if (!titleTokensV234(hint).length) return null;

  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const access = await accessibleTranscriptQueryForUser(req);
  const transcripts = await Transcript.find(access.query)
    .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .sort({ startDateTime:-1, createdAt:-1 })
    .limit(900)
    .lean();

  const strictMatches = transcripts
    .filter(t => isStrictMeetingTitleMatchV234(hint, t.subject))
    .map(t => ({ t, score: meetingTitleScoreV234(hint, t.subject), dt: new Date(t.startDateTime || 0) }))
    .filter(x => Number.isFinite(x.dt.getTime()))
    .sort((a,b) => (b.score - a.score) || (b.dt - a.dt));

  if (!strictMatches.length) return null;

  let target = null;
  if (routed.intent === 'PREP_NEXT') {
    const win = meetingDateWindowV234('tomorrow');
    const events = await EventCache.find({
      orgId,
      userEmail: { $in: principals },
      startDateTime: { $gte: win.from.toISOString(), $lte: win.to.toISOString() },
    }).sort({ startDateTime: 1 }).limit(80).lean().catch(() => []);
    const eventMatches = events
      .filter(e => isStrictMeetingTitleMatchV234(hint, e.subject))
      .map(e => ({ subject:e.subject, startDateTime:e.startDateTime, eventId:e.eventId, source:'tomorrow-calendar', score:meetingTitleScoreV234(hint, e.subject) }))
      .sort((a,b) => (b.score-a.score) || (new Date(a.startDateTime||0)-new Date(b.startDateTime||0)));
    target = eventMatches[0] || { subject: strictMatches[0].t.subject, startDateTime: '', source:'matched-thread-history' };
  } else {
    target = { subject: strictMatches[0].t.subject, startDateTime: strictMatches[0].t.startDateTime, eventId: strictMatches[0].t.eventId, source:'matched-transcript' };
  }

  let selected = [];
  if (routed.intent === 'SUMMARY_TODAY' || routed.intent === 'SUMMARY_YESTERDAY') {
    const win = meetingDateWindowV234(routed.dateMode);
    selected = strictMatches.filter(x => x.dt >= win.from && x.dt <= win.to).sort((a,b)=>b.dt-a.dt).slice(0,1).map(x=>x.t);
  } else if (routed.intent === 'SUMMARY_LAST' || routed.intent === 'THREAD_OVERVIEW') {
    selected = strictMatches.sort((a,b)=>b.dt-a.dt).slice(0, routed.intent === 'THREAD_OVERVIEW' ? 5 : 1).map(x=>x.t);
  } else if (routed.intent === 'PREP_NEXT') {
    const before = target?.startDateTime ? new Date(target.startDateTime) : new Date();
    selected = strictMatches.filter(x => !Number.isFinite(before.getTime()) || x.dt < before).sort((a,b)=>b.dt-a.dt).slice(0,5).map(x=>x.t);
    if (!selected.length) selected = strictMatches.sort((a,b)=>b.dt-a.dt).slice(0,5).map(x=>x.t);
  }
  if (!selected.length) {
    const reply = `I found the meeting thread for "${target?.subject || hint}", but not a matching occurrence for ${routed.dateMode}.`;
    return { answer: reply, model:'deterministic-v23.4', intent:routed.intent, mode:'v23.4-no-date-match', target, sources: [] };
  }

  for (const t of selected.slice(0, 5)) await ensureTranscriptChunksForDoc(t).catch(()=>{});
  const ids = selected.map(t => t._id);
  const chunks = await TranscriptChunk.find({ orgId, transcriptDocId: { $in: ids } })
    .sort({ transcriptDocId: 1, chunkIndex: 1 })
    .select({ transcriptDocId:1, chunkIndex:1, text:1 })
    .limit(routed.intent === 'PREP_NEXT' ? 35 : 12)
    .lean();

  let context = [
    `V23.4 HARD MEETING BOUNDARY: Use ONLY the listed matched occurrences. Do not use global actions, unrelated meetings, leadership calls, or semantically similar notes.`,
    `Intent: ${routed.intent}`,
    `User meeting hint: ${hint}`,
    `Resolved target: ${target?.subject || selected[0]?.subject || 'Meeting'} | ${target?.startDateTime || ''} | ${target?.source || ''}`,
    `Selected occurrence count: ${selected.length}`,
  ].join('\n') + '\n\n';
  for (const t of selected) {
    context += `Meeting occurrence: ${t.subject || 'Meeting'}\nDate: ${t.startDateTime || 'Unknown'}\n`;
    if (t.ai?.summary) context += `Summary:\n${String(t.ai.summary).slice(0,2500)}\n`;
    if (t.ai?.detailedNotes) context += `Detailed notes:\n${String(t.ai.detailedNotes).slice(0,3500)}\n`;
    for (const c of chunks.filter(c => String(c.transcriptDocId) === String(t._id)).slice(0, routed.intent === 'PREP_NEXT' ? 5 : 3)) context += `Transcript chunk ${c.chunkIndex}:\n${String(c.text||'').slice(0,1600)}\n`;
    context += '\n---\n';
    if (context.length > 24000) break;
  }

  let answer, model;
  if (process.env.OPENAI_API_KEY) {
    const specificQuestion = routed.intent === 'PREP_NEXT'
      ? `${query}\n\nAnswer only as preparation for the resolved target meeting. Use only prior occurrences of the same meeting thread.`
      : `${query}\n\nAnswer only from the selected ${routed.dateMode} occurrence(s) of the resolved meeting thread.`;
    const generated = await generateMeetingAnswer({ question: specificQuestion, context, subject: target?.subject || selected[0]?.subject || 'Matched meeting' });
    answer = generated.answer; model = generated.model;
  } else {
    answer = deterministicMeetingAnswerV234({ query, intent:routed.intent, target, transcripts:selected });
    model = 'deterministic-v23.4';
  }
  const sources = selected.map(t => ({ transcriptDocId:String(t._id), subject:t.subject||'Meeting', startDateTime:t.startDateTime||'', match:`v23.4 ${routed.intent} strict-thread` }));
  return { answer, model, sources, intent:routed.intent, mode:'v23.4-intent-aware-meeting-copilot', target, confidence: selected.length >= 2 || routed.intent !== 'PREP_NEXT' ? 'High' : 'Medium' };
}

router.post('/chat/answer', requireUser, async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    const singleId = String(req.body?.transcriptDocId || '').trim();
    const manyIds = Array.isArray(req.body?.transcriptDocIds) ? req.body.transcriptDocIds : [];
    const chatMode = String(req.body?.mode || 'auto').trim().toLowerCase();

    const requestedIds = [...new Set([
      singleId,
      ...manyIds.map(x => String(x || '').trim()),
    ].filter(Boolean))];

    if (!query) {
      return res.status(400).json({ ok: false, error: 'query required' });
    }

    await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'user', message: query });

    // v17.2: route first, then execute. Executive-briefing language must never
    // fall into the action-assignment slot-filling flow.
    const routedIntent = classifyExecutiveIntent(query);
    if (routedIntent.intent === 'executive_briefing' || routedIntent.intent === 'escalation_analysis' || isChiefOfStaffFocusQuery(query)) {
      const brief = await buildChiefOfStaffBriefForUser(req, query, routedIntent);
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: brief.answer, model: brief.model || '', sources: brief.sources || [] });
      return res.json({ ok: true, answer: brief.answer, model: brief.model, intent: routedIntent.intent, sources: brief.sources || [] });
    }

    if (routedIntent.intent === 'action_assignment' || routedIntent.intent === 'note_capture' || routedIntent.intent === 'memory_management') {
      const commandFlow = await handleChatCommandFlow(req, query);
      if (commandFlow && commandFlow.handled) {
        return res.json({ ok: true, answer: commandFlow.answer, intent: routedIntent.intent, sources: commandFlow.sources || [] });
      }
    }

    // v23.4: intent-aware meeting copilot runs before operating graph/global RAG,
    // and it deliberately ignores client-provided retrieved IDs for meeting-specific
    // questions. The server must resolve the meeting/time scope itself so unrelated
    // meetings cannot contaminate answers.
    try {
      const scopedMeeting = await answerIntentAwareMeetingV234(req, query);
      if (scopedMeeting) {
        await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: scopedMeeting.answer, model: scopedMeeting.model || '', sources: scopedMeeting.sources || [] });
        return res.json({ ok:true, answer: scopedMeeting.answer, model: scopedMeeting.model, intent: scopedMeeting.intent, mode:scopedMeeting.mode, target: scopedMeeting.target, confidence: scopedMeeting.confidence, sources: scopedMeeting.sources || [] });
      }
    } catch (meetingErr) {
      console.warn('[chat/answer] v23.4 intent-aware meeting copilot skipped:', meetingErr.message || String(meetingErr));
    }

    // v23: operating-graph answer mode. Kili now understands actions, people,
    // threads, blockers and metrics before falling back to transcript-only RAG.
    const wantsOpsGraph = chatMode !== 'auto' || /\b(action|actions|owner|owns|owning|blocked|blocker|thread|metric|trend|person|people|follow up|follow-up|decision|risk|stale|slipping)\b/i.test(query);
    if (wantsOpsGraph && process.env.OPENAI_API_KEY) {
      try {
        const principals = getUserPrincipals(req.user);
        const orgId = req.user.org._id;
        const terms = importantTerms(query).slice(0, 8);
        const regexes = terms.map(t => new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        const textOr = regexes.length ? { $or: regexes.flatMap(rx => [{ title: rx }, { description: rx }, { ownerName: rx }, { ownerEmail: rx }, { meetingSubject: rx }, { blockedReason: rx }, { 'comments.body': rx }]) } : {};
        const actionScope = { orgId, $or: [{ ownerEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }, { assignedByEmail: { $in: principals } }] };
        const actions = await ActionItem.find({ ...actionScope, ...textOr }).sort({ dueDateISO: 1, updatedAt: -1 }).limit(30).lean();
        const threadTextOr = regexes.length ? { $or: regexes.flatMap(rx => [{ name: rx }, { objective: rx }, { ownerEmail: rx }, { contributorEmails: rx }, { 'entries.title': rx }, { 'entries.body': rx }, { 'entries.ownerEmail': rx }]) } : {};
        const threads = await MeetingThread.find({ ...threadAccessQuery(req), ...threadTextOr }).sort({ updatedAt: -1 }).limit(18).lean();
        const people = await User.find({ org: orgId, status: 'active', ...(regexes.length ? { $or: regexes.flatMap(rx => [{ name: rx }, { email: rx }]) } : {}) }).select({ name:1,email:1,role:1 }).limit(20).lean();
        const threadIds = threads.map(t => t._id);
        const metrics = threadIds.length ? await ThreadMetric.find({ orgId, threadId: { $in: threadIds }, 'acl.allowedEmails': { $in: principals } }).sort({ updatedAt: -1 }).limit(20).lean() : [];
        if (actions.length || threads.length || people.length || metrics.length) {
          const context = [
            `Assistant mode: ${chatMode}. Use this operating graph first. Be direct, cite evidence, and say when evidence is weak.`,
            `Actions:\n${actions.map((a,i)=>`${i+1}. ${a.title} | owner=${a.ownerName||a.ownerEmail||'Unassigned'} | status=${a.status} | due=${a.dueDate||a.dueDateISO||'Unclear'} | meeting=${a.meetingSubject||'General'} | blocked=${a.blockedReason||''} | latestComment=${(a.comments||[]).slice(-1)[0]?.body||''}`).join('\n') || 'No matching actions.'}`,
            `Threads:\n${threads.map((t,i)=>`${i+1}. ${t.name} | owner=${t.ownerEmail||'Unassigned'} | status=${t.status||'Active'} | objective=${t.objective||''} | health=${t.ai?.healthLabel||''} ${t.ai?.healthScore||''} | latest=${(t.entries||[]).slice(-3).map(e=>`${e.kind}:${e.title||e.body||''}`).join(' ; ')}`).join('\n') || 'No matching threads.'}`,
            `People:\n${people.map((u,i)=>`${i+1}. ${u.name||u.email} | ${u.email} | role=${u.role||''}`).join('\n') || 'No matching people.'}`,
            `Thread metrics:\n${metrics.map((m,i)=>`${i+1}. ${m.name} | thread=${m.threadId} | chart=${m.chartType||'line'} | latest=${(m.points||[]).slice(-1)[0]?.value ?? 'none'} ${m.unit||''}`).join('\n') || 'No matching metrics.'}`
          ].join('\n\n');
          const { answer, model } = await generateMeetingAnswer({ question: query, context, subject: 'Operating graph: actions, people, threads and metrics' });
          const sources = [
            ...actions.slice(0,5).map(a=>({ subject:a.title, startDateTime:String(a.updatedAt||a.createdAt||''), match:'action' })),
            ...threads.slice(0,5).map(t=>({ subject:t.name, startDateTime:String(t.updatedAt||t.createdAt||''), match:'thread' })),
            ...metrics.slice(0,3).map(m=>({ subject:m.name, startDateTime:String(m.updatedAt||m.createdAt||''), match:'metric' }))
          ];
          await ChatMessage.create({ orgId, userId: req.user._id, role: 'assistant', message: answer, model, sources });
          return res.json({ ok:true, answer, model, intent:'operating_graph', mode:chatMode, sources });
        }
      } catch (opsErr) {
        console.warn('[chat/answer] v23 operating graph skipped:', opsErr.message || String(opsErr));
      }
    }

    // v15 thread-aware answer mode: when chat is opened from a thread page, answer from that outcome memory first.
    const threadIdForChat = String(req.body?.threadId || '').trim();
    if (threadIdForChat && process.env.OPENAI_API_KEY) {
      const thread = await MeetingThread.findOne({ _id: threadIdForChat, orgId: req.user.org._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).lean();
      if (thread) {
        const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id })
          .select({ subject:1, startDateTime:1, text:1, 'ai.summary':1, 'ai.detailedNotes':1 })
          .sort({ startDateTime: 1 })
          .limit(25)
          .lean();
        const entries = (thread.entries || []).slice(-80).map(e => [
          `${String(e.kind || '').toUpperCase()}: ${e.title || ''}`,
          e.body || '',
          e.ownerEmail ? `Owner: ${e.ownerEmail}` : '',
          e.dueDate ? `Due: ${e.dueDate}` : '',
          e.status ? `Status: ${e.status}` : '',
          e.severity ? `Severity: ${e.severity}` : ''
        ].filter(Boolean).join('\n')).join('\n\n---\n\n');
        const meetingCtx = meetings.map((m,i)=>[
          `Meeting ${i+1}: ${m.subject || 'Meeting'}`,
          `Date: ${m.startDateTime || ''}`,
          `Summary:\n${m.ai?.summary || ''}`,
          `Detailed notes:\n${m.ai?.detailedNotes || ''}`,
          `Transcript excerpt:\n${String(m.text || '').slice(0,4000)}`
        ].join('\n')).join('\n\n---\n\n');
        const context = [
          `Outcome Thread: ${thread.name}`,
          thread.objective ? `Objective: ${thread.objective}` : '',
          thread.desiredOutcome ? `Desired outcome: ${thread.desiredOutcome}` : '',
          `Status: ${thread.status || 'Active'}`,
          thread.ai?.executiveMemory ? `Existing AI Memory:\n${thread.ai.executiveMemory}` : '',
          entries ? `Thread notes/decisions/risks/actions:\n${entries}` : '',
          meetingCtx
        ].filter(Boolean).join('\n\n');
        const { answer, model } = await generateMeetingAnswer({ question: query, context: context.slice(0,26000), subject: `Thread: ${thread.name}` });
        const grounded = `${answer}\n\nSource used: Outcome Thread — ${thread.name}`;
        await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: grounded, model });
        return res.json({ ok:true, answer: grounded, model, sources: [{ subject: `Thread: ${thread.name}`, startDateTime: String(thread.updatedAt || '') }] });
      }
    }

    // v8 deterministic action creation through chatbot
    const actionMatch = query.match(/(?:assign|create|add)\s+(?:an\s+)?(?:action|follow\s*up|todo)\s+(?:item\s+)?(?:to\s+)?(.+?)(?:\s+to\s+([A-Za-z][A-Za-z ._-]+|[\w.+-]+@[\w.-]+))?(?:\s+by\s+([^?.]+))?$/i);
    if (actionMatch && canAssignActions(req.user)) {
      const title = String(actionMatch[1] || '').trim().slice(0,220);
      const ownerHint = String(actionMatch[2] || '').trim().toLowerCase();
      const dueHint = String(actionMatch[3] || '').trim();
      const parsedDue = parseNaturalDueDate(dueHint || query);
      if (!parsedDue.date) {
        const reply = 'I can create that action item, but I need a clear due date first. Please say something like: by tomorrow, by next Friday, or by 2026-05-30.';
        await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
        return res.json({ ok: true, answer: reply, sources: [] });
      }
      const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1 }).lean();
      let assignee = ownerHint ? users.find(u => String(u.email).toLowerCase() === ownerHint || String(u.name||'').toLowerCase().includes(ownerHint)) : null;
      if (!assignee) assignee = pickAssigneeFromText({ title: query, description: query }, users, [] ).ownerEmail ? users.find(u => u.email === pickAssigneeFromText({ title: query, description: query }, users, []).ownerEmail) : null;
      const item = await ActionItem.create({ orgId: req.user.org._id, title, description: `Created from chat: ${query}`, ownerName: assignee?.name || 'Unassigned', ownerEmail: assignee?.email || '', assignedByUserId: req.user._id, assignedByEmail: req.user.email, source: 'manual', dueDate: parsedDue.label, dueDateISO: parsedDue.date, priority: /urgent|high|critical/i.test(query) ? 'High' : 'Medium', acl: { allowedEmails: [...new Set([req.user.email, assignee?.email].filter(Boolean).map(x=>String(x).toLowerCase()))], updatedAt: new Date() } });
      const reply = `Created action item: ${item.title}
Owner: ${item.ownerName || 'Unassigned'}
Due: ${item.dueDate || 'Unclear'}`;
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
      return res.json({ ok: true, answer: reply, sources: [] });
    }

    if (!requestedIds.length || requestedIds.includes('chat-action-only')) {
      const principals = getUserPrincipals(req.user);
      const terms = importantTerms(query);
      const regexes = (terms.length ? terms : [query]).slice(0,6).map(term => new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

      // v14: if a very strong meeting match exists, answer from that meeting first.
      // This avoids noisy answers that look across unrelated meetings.
      try {
        const access = await accessibleTranscriptQueryForUser(req);
        const extractedTitle = extractMeetingTitleFromQuestion(query);
        const titleHint = extractedTitle || classifyMeetingIntent(query).meetingTitleHint || query;
        const preciseTitleMode = !!extractedTitle && normalizeSubjectKey(extractedTitle).split(/\s+/).filter(Boolean).length >= 2;
        const titleTerms = v12StrongTopicTerms(titleHint).slice(0, 7);
        const ors = titleTerms.length
          ? titleTerms.flatMap(term => {
              const rx = new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
              return [{ subject: rx }, { 'ai.summary': rx }, { 'ai.detailedNotes': rx }, { text: rx }];
            })
          : [];
        const candidates = ors.length
          ? await Transcript.find({ ...access.query, $or: ors })
              .select({ _id:1,eventId:1,subject:1,startDateTime:1,text:1,vtt:1,'ai.summary':1,'ai.detailedNotes':1 })
              .sort({ startDateTime:-1, createdAt:-1 })
              .limit(8)
              .lean()
          : [];
        const normalizedHint = normalizeSubjectKey(titleHint);
        const scored = candidates.map(d => {
            const subjKey = normalizeSubjectKey(d.subject || '');
            const direct = normalizedHint && subjKey && (subjKey.includes(normalizedHint) || normalizedHint.includes(subjKey)) ? 100 : 0;
            const titleOverlap = subjectOverlapRatio(titleHint, d.subject || '');
            const coverage = v12TopicCoverageScore(query, d);
            return { doc: d, coverage, direct, titleOverlap, recent: Date.parse(d.startDateTime || '') || 0 };
          })
          .filter(x => preciseTitleMode ? (x.direct || x.titleOverlap >= 0.55) : (x.coverage.ok || x.direct || x.titleOverlap >= 0.65))
          .sort((a,b) => {
            const wantsLatest = /\b(latest|last|recent)\b/i.test(query);
            if (wantsLatest) {
              const aStrong = (a.direct || a.titleOverlap >= 0.45 || a.coverage.score >= 2) ? 1 : 0;
              const bStrong = (b.direct || b.titleOverlap >= 0.45 || b.coverage.score >= 2) ? 1 : 0;
              if (bStrong !== aStrong) return bStrong - aStrong;
              return (b.recent - a.recent) || (b.direct - a.direct) || (b.titleOverlap - a.titleOverlap) || (b.coverage.score - a.coverage.score);
            }
            return (b.direct - a.direct) || (b.titleOverlap - a.titleOverlap) || (b.recent - a.recent) || (b.coverage.score - a.coverage.score);
          });
        if (scored.length && (scored[0].direct || scored[0].titleOverlap >= 0.45 || scored[0].coverage.score >= (/\b(action|actions|action items|todo|follow[- ]?up|next steps)\b/i.test(query) ? 2 : 4)) && process.env.OPENAI_API_KEY) {
          const d = scored[0].doc;
          await ensureTranscriptChunksForDoc(d).catch(()=>{});
          const strongCtxDocs = await MeetingContext.find({ orgId: req.user.org._id, eventId: String(d.eventId || ''), $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] }).sort({ createdAt:-1 }).limit(10).lean();
          const linkedContextBlock = strongCtxDocs.length ? strongCtxDocs.map((c,i)=>`Linked context ${i+1}: ${c.title || c.sourceType || 'Context'}\nSource: ${c.sourceType || c.contextType || ''}\nAdded: ${c.createdAt || ''}\n${String(c.contextText || c.fileText || '').slice(0,2500)}`).join('\n\n---\n\n') : '';
          const userMemoryBlocks = (await User.findById(req.user._id).select({ memoryBlocks:1 }).lean().catch(()=>null))?.memoryBlocks || [];
          const memoryBlock = userMemoryBlocks.length ? userMemoryBlocks.slice(-12).map((m,i)=>`Memory ${i+1}: ${m.label || 'Memory'}\n${m.body || ''}`).join('\n\n') : '';
          const context = [
            memoryBlock ? `User/team memory that may help interpret people and structure:\n${memoryBlock}` : '',
            `Strong matched meeting: ${d.subject || 'Meeting'}`,
            `Date: ${d.startDateTime || ''}`,
            linkedContextBlock ? `Latest linked context / preparation notes:\n${linkedContextBlock}` : '',
            d.ai?.summary ? `Existing AI summary:\n${d.ai.summary}` : '',
            d.ai?.detailedNotes ? `Existing detailed notes:\n${d.ai.detailedNotes}` : '',
            `Transcript:\n${String(d.text || d.vtt || '').slice(0, 12000)}`
          ].filter(Boolean).join('\n\n');
          const { answer, model } = await generateMeetingAnswer({ question: query, context, subject: d.subject || 'Strong matched meeting' });
          const grounded = `${answer}\n\nSource used: ${d.subject || 'Meeting'}${d.startDateTime ? ` (${prettyLocalTimeLabel(d.startDateTime) || d.startDateTime})` : ''}`;
          await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: grounded, model });
          return res.json({ ok:true, answer: grounded, model, sources: [{ transcriptDocId:String(d._id), subject:d.subject||'Meeting', startDateTime:d.startDateTime||'', match:'strong' }] });
        }
      } catch (strongMatchErr) {
        console.warn('[chat/answer] v14 strong-match path failed:', strongMatchErr.message || String(strongMatchErr));
      }

      // v16.5: personal memory notes are first-class RAG context. If the user asks
      // what to remember/remind/follow up, search active personal notes before broad meeting memory.
      if (/\b(remember|remind|note|notes|personal memory|what.*remember|follow up reminders?)\b/i.test(query)) {
        const noteAnd = [{ $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] }];
        if (regexes.length) noteAnd.push({ $or: regexes.flatMap(rx => [{ contextText: rx }, { title: rx }]) });
        const personalNotes = await MeetingContext.find({
          orgId: req.user.org._id,
          contextType: 'personal_note',
          noteStatus: { $ne: 'done' },
          $and: noteAnd,
        }).sort({ remindUntil: 1, createdAt:-1 }).limit(12).lean();
        if (personalNotes.length && process.env.OPENAI_API_KEY) {
          const context = personalNotes.map((c,i)=>`Personal note ${i+1}: ${c.title || 'Note'}\nAdded: ${c.createdAt || ''}\nActive until: ${c.remindUntil || 'not set'}\n${String(c.contextText || '').slice(0,2500)}`).join('\\n\\n---\\n\\n');
          const { answer, model } = await generateMeetingAnswer({ question: query, context, subject: 'Personal memory notes' });
          await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: answer, model });
          return res.json({ ok: true, answer, model, sources: personalNotes.map(c=>({ subject:c.title||'Personal note', startDateTime:String(c.remindUntil || c.createdAt || '') })) });
        }
      }

      const ctxDocs = await MeetingContext.find({ orgId: req.user.org._id, $and: [{ $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] }, { $or: regexes.flatMap(rx => [{ contextText: rx }, { fileText: rx }, { title: rx }, { fileName: rx }]) }] }).sort({ createdAt:-1 }).limit(8).lean();
      if (ctxDocs.length && process.env.OPENAI_API_KEY) {
        const context = ctxDocs.map((c,i)=>`Meeting context/file ${i+1}: ${c.title || c.fileName || 'Context'}\nFile: ${c.fileName || ''}\n${String(c.contextText || '').slice(0,2000)}\n${String(c.fileText || '').slice(0,5000)}`).join('\n\n');
        const { answer, model } = await generateMeetingAnswer({ question: query, context, subject: 'Meeting attached files and context' });
        await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: answer, model });
        return res.json({ ok: true, answer, model, sources: ctxDocs.map(c=>({ subject:c.title||c.fileName||'Meeting context', startDateTime:String(c.createdAt||'') })) });
      }
      // v11.3 rescue path: if UI retrieval failed, still search all accessible transcripts
      // through ACL + the user's calendar cache. This prevents “Transcript” cards from being
      // invisible to the chatbot just because chunks/ACL were not prebuilt yet.
      try {
        const access = await accessibleTranscriptQueryForUser(req);
        const termsForTranscript = importantTerms(query);
        const rxOrs = termsForTranscript.slice(0,8).flatMap(term => {
          const rx = new RegExp(String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          return [{ subject: rx }, { text: rx }, { 'ai.summary': rx }, { 'ai.detailedNotes': rx }];
        });
        if (rxOrs.length) {
          const docs = await Transcript.find({ ...access.query, $or: rxOrs })
            .select({ _id:1, eventId:1, subject:1, startDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
            .sort({ startDateTime:-1, createdAt:-1 })
            .limit(5)
            .lean();
          if (docs.length && process.env.OPENAI_API_KEY) {
            for (const d of docs.slice(0,3)) await ensureTranscriptChunksForDoc(d).catch(()=>{});
            const context = docs.map((d,i)=>`Meeting ${i+1}: ${d.subject || 'Meeting'}\nDate: ${d.startDateTime || ''}\nSummary:\n${d.ai?.summary || ''}\nDetailed notes:\n${d.ai?.detailedNotes || ''}\nTranscript:\n${String(d.text || d.vtt || '').slice(0,7000)}`).join('\n\n---\n\n').slice(0,18000);
            const { answer, model } = await generateMeetingAnswer({ question: query, context, subject: docs[0].subject || 'Matched meeting transcript' });
            await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: answer, model });
            return res.json({ ok:true, answer, model, sources: docs.map(d=>({ transcriptDocId:String(d._id), subject:d.subject||'Meeting', startDateTime:d.startDateTime||'', match:'accessible transcript' })) });
          }
        }
      } catch (rescueErr) {
        console.warn('[chat/answer] transcript rescue failed:', rescueErr.message || String(rescueErr));
      }

      const reply = /latest|last|previous|meeting|kotak|commerz|ing/i.test(query) ? 'I could not find a matching accessible transcript/context for that topic. Use Load to AI Context on the meeting card, then ask again.' : 'I can create action items from chat, or answer from meeting transcripts/attached meeting context once a matching record is found.';
      await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: reply });
      return res.json({ ok: true, answer: reply, sources: [] });
    }

    const orgId = req.user.org._id;
    const principals = getUserPrincipals(req.user);

    // Access guard: transcript may be visible by explicit ACL OR by the user's cached calendar event.
    const access = await accessibleTranscriptQueryForUser(req);
    const transcripts = await Transcript.find({
      ...access.query,
      _id: { $in: requestedIds },
    })
      .select({ _id: 1, eventId: 1, subject: 1, startDateTime: 1, 'ai.summary': 1, 'ai.detailedNotes': 1, text: 1, vtt: 1 })
      .lean();

    if (!transcripts.length) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const allowedIds = transcripts.map(t => t._id);
    const tMap = new Map(transcripts.map(t => [String(t._id), t]));

    // Fetch only relevant transcript chunks first, not entire meeting history.
    // This keeps the chatbot grounded in previous transcript evidence.
    let chunks = [];
    try {
      chunks = await TranscriptChunk.find(
        {
          orgId,
          transcriptDocId: { $in: allowedIds },
          $text: { $search: query },
        },
        {
          score: { $meta: 'textScore' },
          transcriptDocId: 1,
          chunkIndex: 1,
          text: 1,
        }
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(16)
        .lean();
    } catch (e) {
      const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      chunks = await TranscriptChunk.find({
        orgId,
        transcriptDocId: { $in: allowedIds },
        text: { $regex: esc, $options: 'i' },
      })
        .select({ transcriptDocId: 1, chunkIndex: 1, text: 1 })
        .limit(16)
        .lean();
    }

    // Fallback: if text search finds nothing, use the first few chunks from selected allowed transcripts.
    if (!chunks.length) {
      chunks = await TranscriptChunk.find({
        orgId,
        transcriptDocId: { $in: allowedIds },
      })
        .sort({ transcriptDocId: 1, chunkIndex: 1 })
        .select({ transcriptDocId: 1, chunkIndex: 1, text: 1 })
        .limit(16)
        .lean();
    }

    const MAX_CHARS = 18000;
    const recentChat = await ChatMessage.find({ orgId: req.user.org._id, userId: req.user._id }).sort({ createdAt: -1 }).limit(8).lean();
    let context = recentChat.length ? 'Recent chat context (use only to understand follow-up references, not as meeting evidence):\n' + recentChat.reverse().map(m => `${m.role}: ${m.message}`).join('\n').slice(0, 2500) + '\n\n' : ''; 
    const sourceMap = new Map();

    // Put meeting-level AI notes first. This makes "tell me about the last X meeting" work
    // even when exact keyword chunks are weak. Raw transcript chunks still ground the answer.
    for (const t of transcripts) {
      sourceMap.set(String(t._id), {
        transcriptDocId: String(t._id),
        subject: t.subject || 'Meeting',
        startDateTime: t.startDateTime || '',
      });
      const summaryBlock = [
        `Meeting: ${t.subject || 'Untitled'}`,
        `Date: ${t.startDateTime || 'Unknown'}`,
        t.ai?.summary ? `Existing AI summary:\n${t.ai.summary}` : '',
        t.ai?.detailedNotes ? `Existing detailed notes:\n${t.ai.detailedNotes}` : '',
      ].filter(Boolean).join('\n');
      if (summaryBlock.trim()) {
        const block = `${summaryBlock}\n\n`;
        if ((context.length + block.length) <= MAX_CHARS) context += block;
      }
    }

    const relatedEventIds = transcripts.map(t => String(t.eventId || '')).filter(Boolean);
    if (relatedEventIds.length) {
      const ctxDocs = await MeetingContext.find({ orgId, eventId: { $in: relatedEventIds }, $or: [{ 'acl.allowedEmails': { $in: principals } }, { addedByEmail: { $in: principals } }] }).sort({ createdAt: -1 }).limit(12).lean();
      for (const c of ctxDocs) {
        const block = `Attached meeting context/file: ${c.title || c.fileName || 'Context'}\nFile: ${c.fileName || ''}\n${String(c.contextText || '').slice(0,2000)}\n${String(c.fileText || '').slice(0,5000)}\n\n`;
        if ((context.length + block.length) <= MAX_CHARS) context += block;
      }
    }

    for (const c of chunks) {
      const t = tMap.get(String(c.transcriptDocId));
      if (!t) continue;
      const block = `Meeting: ${t.subject || 'Untitled'}\nDate: ${t.startDateTime || 'Unknown'}\nTranscript chunk ${c.chunkIndex}:\n${String(c.text || '').trim()}\n\n`;
      if ((context.length + block.length) > MAX_CHARS) break;
      context += block;
    }

    if (!context.trim()) {
      return res.json({ ok: true, answer: 'I found the meeting record, but no transcript or AI notes have been stored yet.' });
    }

    const { answer, model } = await generateMeetingAnswer({
      question: query,
      context,
      subject: transcripts.length === 1 ? transcripts[0].subject : 'Multiple previous meeting transcripts',
    });

    const sources = Array.from(sourceMap.values());
    await ChatMessage.create({ orgId: req.user.org._id, userId: req.user._id, role: 'assistant', message: answer, model, sources });

    return res.json({
      ok: true,
      answer,
      model,
      sources,
    });
  } catch (e) {
    console.error('[chat/answer] error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'server error' });
  }
});


router.get('/dashboard', requireUser, async (req, res) => {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const from = req.query.from ? new Date(req.query.from) : startOfDay(addDays(new Date(), -30));
  const to = req.query.to ? endOfDay(new Date(req.query.to)) : endOfDay(new Date());
  const filter = { orgId, createdAt: { $gte: from, $lte: to } };
  if (req.user.role !== 'super_admin' && req.user.role !== 'ceo') filter.$or = [{ ownerEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }];
  const actions = await ActionItem.find(filter).lean();
  const statusCounts = actions.reduce((m,a)=>{m[a.status||'Open']=(m[a.status||'Open']||0)+1;return m;},{});
  const ownerActionMap = actions.reduce((m,a)=>{const k=a.ownerName||a.ownerEmail||'Unassigned'; (m[k]=m[k]||[]).push(a); return m;},{});
  const byOwner = Object.fromEntries(Object.entries(ownerActionMap).map(([k,v])=>[k,v.length]));
  const recentDone = actions.filter(a=>a.status==='Done').slice(0,10);
  res.render('user/dashboard', { title: 'Dashboard', activeNav: 'dashboard', user: req.user, org: req.user.org, actions, statusCounts, byOwner, ownerActionMap, recentDone, from, to });
});

function periodRange(kind, fromRaw, toRaw) {
  const now = new Date();
  if (kind === 'weekly') {
    const d = new Date(now); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return { start: startOfDay(d), end: endOfDay(now) };
  }
  if (kind === 'monthly') return { start: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), end: endOfDay(now) };
  const f = fromRaw ? new Date(fromRaw) : startOfDay(addDays(now, -7));
  const t = toRaw ? new Date(toRaw) : now;
  return { start: startOfDay(f), end: endOfDay(t) };
}
async function buildSummaryForUser({ orgId, targetUser, kind, start, end }) {
  const principals = [String(targetUser.email||'').toLowerCase()].filter(Boolean);
  const transcripts = await Transcript.find({ orgId, startDateTime: { $gte: start.toISOString(), $lte: end.toISOString() }, 'acl.allowedEmails': { $in: principals } }).select({ subject:1,startDateTime:1,'ai.summary':1,'ai.detailedNotes':1 }).sort({ startDateTime:1 }).lean();
  const calendarMeetings = await EventCache.find({ orgId, userEmail: { $in: principals }, startDateTime: { $gte: start.toISOString(), $lte: end.toISOString() } }).select({ subject:1,startDateTime:1,hasTranscript:1 }).sort({ startDateTime:1 }).limit(200).lean();
  const actions = await ActionItem.find({ orgId, $or: [{ ownerEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }], createdAt: { $lte: end } }).sort({ status:1, dueDateISO:1, createdAt:-1 }).limit(200).lean();
  const done = actions.filter(a=>a.status==='Done');
  const open = actions.filter(a=>a.status!=='Done' && a.status!=='Dropped');
  const title = `${kind[0].toUpperCase()+kind.slice(1)} Summary — ${targetUser.name || targetUser.email}`;
  const body = [
    `${title}`,
    `Period: ${start.toDateString()} to ${end.toDateString()}`,
    '',
    'Executive focus',
    (calendarMeetings.length || transcripts.length) ? (calendarMeetings.length ? calendarMeetings : transcripts).slice(0,18).map((t,i)=>`${i+1}. ${t.subject || 'Meeting'} — ${t.startDateTime || ''}${t.hasTranscript === false ? ' (no transcript saved)' : ''}`).join('\n') : 'No calendar meetings or saved transcripts found for this period.',
    '',
    'Completed actions',
    done.length ? done.slice(0,20).map((a,i)=>`${i+1}. ${a.title} (${a.meetingSubject || 'General'})`).join('\n') : 'No completed actions in this view.',
    '',
    'Open / follow-up actions',
    open.length ? open.slice(0,30).map((a,i)=>`${i+1}. ${a.title} — Owner: ${a.ownerName || a.ownerEmail || 'Unassigned'}; Due: ${a.dueDate || 'Unclear'}; Status: ${a.status}`).join('\n') : 'No pending actions.',
    '',
    'Meeting notes snapshot',
    transcripts.slice(0,8).map((t,i)=>`${i+1}. ${t.subject || 'Meeting'}\n${String(t.ai?.summary || t.ai?.detailedNotes || 'Transcript saved; summary not generated yet.').slice(0,800)}`).join('\n\n')
  ].join('\n');
  return { title, body, transcripts, calendarMeetings, actions };
}
router.get('/summaries', requireUser, async (req, res) => {
  if (!['super_admin','ceo'].includes(req.user.role)) return res.status(403).send('Only CEO/Superadmin can generate summaries.');
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1,email:1,role:1 }).sort({ name:1,email:1 }).lean();
  const latest = await SummaryDigest.find({ orgId: req.user.org._id }).sort({ createdAt:-1 }).limit(15).lean();
  res.render('user/summaries', { title: 'Summaries', activeNav: 'summaries', user: req.user, org: req.user.org, users, latest, generated: null, selectedUserId: String(req.user._id), selectedType: 'weekly', selectedFrom: '', selectedTo: '' });
});
router.post('/summaries/generate', requireUser, async (req, res) => {
  if (!['super_admin','ceo'].includes(req.user.role)) return res.status(403).send('Only CEO/Superadmin can generate summaries.');
  const kind = ['weekly','monthly','custom'].includes(req.body.type) ? req.body.type : 'weekly';
  const targetUser = await User.findOne({ _id: req.body.userId, org: req.user.org._id }).lean();
  if (!targetUser) return res.status(404).send('User not found');
  const { start, end } = periodRange(kind, req.body.from, req.body.to);
  const built = await buildSummaryForUser({ orgId: req.user.org._id, targetUser, kind, start, end });
  const digest = await SummaryDigest.create({ orgId: req.user.org._id, userId: targetUser._id, email: targetUser.email, type: kind, periodStart: start, periodEnd: end, subject: built.title, body: built.body, status: 'created' });
  const users = await User.find({ org: req.user.org._id, status: 'active' }).select({ name:1,email:1,role:1 }).sort({ name:1,email:1 }).lean();
  const latest = await SummaryDigest.find({ orgId: req.user.org._id }).sort({ createdAt:-1 }).limit(15).lean();
  res.render('user/summaries', { title: 'Summaries', activeNav: 'summaries', user: req.user, org: req.user.org, users, latest, generated: digest, selectedUserId: String(targetUser._id), selectedType: kind, selectedFrom: req.body.from || '', selectedTo: req.body.to || '' });
});
router.get('/summaries/:id/download.doc', requireUser, async (req, res) => {
  const d = await SummaryDigest.findOne({ _id: req.params.id, orgId: req.user.org._id }).lean();
  if (!d) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="summary-${d._id}.doc"`);
  res.send(`<html><body><pre style="font-family:Arial;white-space:pre-wrap">${String(d.body||'').replace(/[<&>]/g,c=>({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]))}</pre></body></html>`);
});
router.get('/summaries/:id/download.pdf', requireUser, async (req, res) => {
  const d = await SummaryDigest.findOne({ _id: req.params.id, orgId: req.user.org._id }).lean();
  if (!d) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="summary-${d._id}.pdf"`);
  res.send(simplePdfBuffer(d.subject, d.body));
});

router.post('/calendar/refresh/start', requireUser, async (req, res) => {
  const key = `${req.user.org._id}:${String(req.user.email).toLowerCase()}`;
  global.__calendarRefresh = global.__calendarRefresh || {};
  const current = global.__calendarRefresh[key];
  if (current && current.status === 'running') return res.json({ ok:true, status: current });
  global.__calendarRefresh[key] = { status:'running', startedAt:new Date(), message:'Refreshing calendar…' };
  (async()=>{
    try {
      // Existing refresh route is auth-aware in request; background worker cannot reuse token safely here.
      global.__calendarRefresh[key] = { status:'needs_page_refresh', finishedAt:new Date(), message:'Open Calendar once to complete Graph-backed refresh.' };
    } catch(e) { global.__calendarRefresh[key] = { status:'error', finishedAt:new Date(), error:e.message || String(e) }; }
  })();
  res.json({ ok:true, status: global.__calendarRefresh[key] });
});
router.get('/calendar/refresh/status', requireUser, async (req, res) => {
  const key = `${req.user.org._id}:${String(req.user.email).toLowerCase()}`;
  global.__calendarRefresh = global.__calendarRefresh || {};
  res.json({ ok:true, status: global.__calendarRefresh[key] || { status:'idle' } });
});

router.post('/calendar/:eventId/files', requireUser, meetingFileUpload.single('meetingFile'), async (req, res) => {
  const eventId = String(req.params.eventId || '');
  const file = req.file;
  const pasted = String(req.body.fileText || '').trim();
  const extracted = safeReadTextFile(file);
  await MeetingContext.create({
    orgId: req.user.org._id,
    eventId,
    addedByUserId: req.user._id,
    addedByEmail: req.user.email,
    title: String(req.body.title || file?.originalname || 'Meeting file/context').trim(),
    contextText: String(req.body.contextText || '').trim(),
    fileName: file?.originalname || String(req.body.fileName || '').trim(),
    fileText: extracted || pasted,
    originalName: file?.originalname || '',
    storedName: file?.filename || '',
    filePath: file?.path || '',
    mimeType: file?.mimetype || '',
    sizeBytes: file?.size || 0,
    acl: { allowedEmails: [String(req.user.email).toLowerCase()], updatedAt: new Date() }
  });
  await writeAudit(req, 'MEETING_FILE_ATTACHED', 'EventCache', eventId, `Attached file/context to meeting ${eventId}`, { fileName: file?.originalname || '' });
  res.redirect('/user/calendar');
});



router.post('/threads/:threadId/link-preceding', requireUser, async (req, res) => {
  const threadId = String(req.params.threadId || '').trim();
  const fromTranscriptId = String(req.body.fromTranscriptId || '').trim();
  const toTranscriptId = String(req.body.toTranscriptId || '').trim();
  if (!threadId || !fromTranscriptId || !toTranscriptId || fromTranscriptId === toTranscriptId) return res.status(400).send('Choose two different meetings to link.');
  const access = await accessibleTranscriptQueryForUser(req);
  const docs = await Transcript.find({ ...access.query, _id: { $in: [fromTranscriptId, toTranscriptId] } }).select({ _id:1, subject:1, startDateTime:1 }).lean();
  if (docs.length < 2) return res.status(403).send('One or both meetings are not accessible.');
  await MeetingThread.updateOne(
    { _id: threadId, orgId: req.user.org._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } },
    {
      $addToSet: { meetingIds: { $each: [fromTranscriptId, toTranscriptId] } },
      $push: { links: { fromTranscriptId, toTranscriptId, relation: 'precedes', createdBy: req.user._id, createdAt: new Date() } },
    }
  );
  await writeAudit(req, 'THREAD_PRECEDING_LINKED', 'MeetingThread', threadId, 'Linked preceding meeting in thread');
  return res.redirect('/user/threads/' + threadId);
});

router.post('/home/onboarding/dismiss', requireUser, async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { transcriptOnboardingDismissedAt: new Date() } });
  return res.json({ ok: true });
});


router.post('/executive-brief/regenerate', requireUser, async (req, res, next) => {
  try {
    await generateExecutiveBriefForUser({ user: req.user, force: true });
    res.redirect('/user/home');
  } catch (e) { next(e); }
});

router.get('/executive-brief/download.md', requireUser, async (req, res, next) => {
  try {
    const brief = await generateExecutiveBriefForUser({ user: req.user, force: false });
    const md = formatBriefAsMarkdown(brief);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="executive-brief-${brief.briefDate || 'today'}.md"`);
    res.send(md);
  } catch (e) { next(e); }
});

router.get('/executive-brief.json', requireUser, async (req, res, next) => {
  try {
    const brief = await generateExecutiveBriefForUser({ user: req.user, force: String(req.query.regenerate || '') === '1' });
    res.json({ ok: true, brief });
  } catch (e) { next(e); }
});

module.exports = router;
