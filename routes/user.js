// routes/user.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');


const Org = require('../models/Org');
const EventCache = require('../models/EventCache');
const UserSyncState = require('../models/UserSyncState');
const TranscriptChunk = require('../models/TranscriptChunk');
const ActionItem = require('../models/ActionItem');
const ChatMessage = require('../models/ChatMessage');
const MeetingThread = require('../models/MeetingThread');
const Briefing = require('../models/Briefing');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const MeetingContext = require('../models/MeetingContext');
const SummaryDigest = require('../models/SummaryDigest');
const ExecutiveBrief = require('../models/ExecutiveBrief');
const ThreadMetric = require('../models/ThreadMetric');
const PersonAlias = require('../models/PersonAlias');
const PersonSignal = require('../models/PersonSignal');
const IntelligenceCache = require('../models/IntelligenceCache');
const IssueReport = require('../models/IssueReport');
const AssistantMapping = require('../models/AssistantMapping');
const AssistantNote = require('../models/AssistantNote');
const MeetingLink = require('../models/MeetingLink');
const { buildPeopleDirectory, refreshPersonSignals } = require('../services/peopleIntelligence.service');
const { generateExecutiveBriefForUser, formatBriefAsMarkdown } = require('../services/executiveBrief.service');

const { getUserPrincipals } = require('../utils/acl');
const ensureUserFreshToken = require('../middleware/ensureUserFreshToken');
const { getCalendarRange } = require('../utils/graph');

const { annotateEventsWithTranscripts, getTranscript, listTranscripts, pickBestTranscriptForEvent, transcriptMatchesEventOccurrence } = require('../utils/transcripts');
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

const calendarImportUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${String(file.originalname || 'invite.ics').replace(/[^a-zA-Z0-9._-]/g, '_')}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(ics|ical)$/i.test(file.originalname || '');
    if (!okExt) return cb(new Error('Only .ics calendar invite files are allowed for calendar import'));
    cb(null, true);
  }
});


function v281SanitizeRichThreadNote(html) {
  let out = String(html || '');
  out = out.replace(/<\/?(script|style|iframe|object|embed)[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s(style|class|id)=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/<(?!\/?(b|strong|i|em|u|br|p|ul|ol|li)\b)[^>]+>/gi, '');
  return out.trim();
}

function sanitizeExecutiveInsight(text) {
  let t = String(text || '').replace(/\r/g, '\n');
  t = t.replace(/#+\s*/g, '');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/Executive Memory\s*/ig, '');
  t = t.replace(/Outcome\s*\/\s*Objective\s*/ig, '');
  t = t.replace(/Current State\s*/ig, '');
  t = t.replace(/Evidence base\s*:?[^\n.]*[.\n]?/ig, '');
  t = t.replace(/Live AI synthesis was unavailable[^.]*\.?/ig, '');
  t = t.replace(/deterministic summary[^.]*\.?/ig, '');
  t = t.replace(/Intelligent Summary\s*-?/ig, '');
  t = t.replace(/\s+-\s+/g, ' ');
  t = t.replace(/\.{2,}/g, '.');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
function firstParagraph(text, max = 420) {
  const t = sanitizeExecutiveInsight(text).split(/\n{2,}/).map(x => x.trim()).filter(Boolean).join(' ');
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}
function briefingFilesFromUpload(files) {
  return (files || []).map(f => ({ originalName: f.originalname, fileName: f.filename, path: `/uploads/meeting-files/${f.filename}`, mimeType: f.mimetype, size: f.size, uploadedAt: new Date() }));
}

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
    const docs = await Transcript.find({ orgId, _id: { $in: ids } }).sort({ createdAt: -1 });
    const byRef = docs.find(d => hasTranscriptPayload(d) && v293TranscriptLikeMatchesEvent(ev, d));
    if (byRef) return byRef;
  }
  const byEvent = await Transcript.findOne({ orgId, eventId: ev.eventId, $or: [{ 'acl.allowedEmails': { $in: principals } }, { participantEmails: { $in: principals } }] }).sort({ startDateTime:-1, createdAt:-1 });
  if (byEvent && hasTranscriptPayload(byEvent) && v293TranscriptLikeMatchesEvent(ev, byEvent)) return byEvent;
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
  res.render('user/login', { title: 'User login', fullBleed: true });
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

function v293EventEndMs(ev) {
  const raw = ev?.endDateTime || toIsoZ(ev?.end) || ev?.end?.dateTime || ev?.startDateTime || toIsoZ(ev?.start) || ev?.start?.dateTime || '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
function v293OccurrenceWindow(ev, opts = {}) {
  const startMs = eventStartMs(ev);
  const endMs = v293EventEndMs(ev) || startMs;
  if (!startMs && !endMs) return null;
  const beforeMs = Number(opts.beforeMs ?? 10 * 60 * 1000);
  const afterMs = Number(opts.afterMs ?? 10 * 60 * 60 * 1000);
  const safeStart = startMs || endMs;
  const safeEnd = endMs || startMs;
  return { startMs: safeStart, endMs: safeEnd, windowStart: safeStart - beforeMs, windowEnd: safeEnd + afterMs, anchor: safeEnd };
}
function v293TranscriptTimes(value) {
  const raw = [
    value?.transcriptCreatedDateTime,
    value?.transcriptStartDateTime,
    value?.transcriptEndDateTime,
    value?.createdDateTime,
    value?.startDateTime,
    value?.endDateTime,
  ];
  return raw.map(x => Date.parse(String(x || ''))).filter(Number.isFinite);
}
function v293NeedsGraphTranscriptTiming(value) {
  const meetingId = String(value?.meetingId || '');
  const transcriptId = String(value?.transcriptId || '');
  if (!meetingId || !transcriptId) return false;
  if (/^manual-/i.test(meetingId) || /^manual-/i.test(transcriptId)) return false;
  return true;
}
function v293HasGraphTranscriptTiming(value) {
  return !!(value?.transcriptCreatedDateTime || value?.transcriptStartDateTime || value?.transcriptEndDateTime || value?.createdDateTime);
}
function v293TranscriptLikeMatchesEvent(ev, value, opts = {}) {
  const w = v293OccurrenceWindow(ev, opts);
  if (!w) return false;
  // For real Teams transcripts, legacy docs without transcript-created timing are not safe to attach
  // to a calendar event. They still appear as saved transcript memories, but not as occurrence-ready.
  if (v293NeedsGraphTranscriptTiming(value) && !v293HasGraphTranscriptTiming(value)) return false;
  const times = v293TranscriptTimes(value);
  if (!times.length) return false;
  return times.some(t => t >= w.windowStart && t <= w.windowEnd);
}
function v293RefMatchesEvent(ev, ref, doc = null) {
  if (doc && !v293TranscriptLikeMatchesEvent(ev, doc)) return false;
  if (ref && (ref.transcriptCreatedDateTime || ref.transcriptStartDateTime || ref.transcriptEndDateTime)) return v293TranscriptLikeMatchesEvent(ev, ref);
  if (doc) return v293TranscriptLikeMatchesEvent(ev, doc);
  return false;
}
function v293TranscriptRefFromGraph(meetingId, t) {
  if (!t) return null;
  return {
    meetingId: String(meetingId || t.meetingId || ''),
    transcriptId: String(t.id || t.transcriptId || ''),
    transcriptCreatedDateTime: String(t.createdDateTime || t.transcriptCreatedDateTime || ''),
    transcriptStartDateTime: String(t.startDateTime || t.transcriptStartDateTime || ''),
    transcriptEndDateTime: String(t.endDateTime || t.transcriptEndDateTime || ''),
  };
}
async function v293SafeExistingRefsForEvent(orgId, ev, refs = []) {
  const list = Array.isArray(refs) ? refs.filter(Boolean) : [];
  if (!list.length) return [];
  const ids = list.map(r => String(r.transcriptDocId || '')).filter(id => mongoose.Types.ObjectId.isValid(id));
  const docs = ids.length ? await Transcript.find({ orgId, _id: { $in: ids } })
    .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, startDateTime:1, endDateTime:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1 })
    .lean().catch(()=>[]) : [];
  const byId = new Map(docs.map(d => [String(d._id), d]));
  return list.filter(r => v293RefMatchesEvent(ev, r, r.transcriptDocId ? byId.get(String(r.transcriptDocId)) : null));
}
async function findSavedTranscriptForEvent(orgId, ev) {
  const eventId = String(ev?.eventId || ev?.id || '').trim();
  const subject = String(ev?.subject || '').trim();
  const startMs = eventStartMs(ev);
  if (eventId) {
    const byEvent = await Transcript.findOne({ orgId, eventId, ...v274TranscriptPayloadQuery() })
      .select({ _id: 1, meetingId: 1, transcriptId: 1, subject: 1, startDateTime: 1, endDateTime: 1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary': 1 })
      .lean();
    if (byEvent && v293TranscriptLikeMatchesEvent(ev, byEvent)) return byEvent;
  }
  if (!subject || !startMs) return null;
  const subjectKey = normalizeSubjectKey(subject);
  const candidates = await Transcript.find({ orgId, subject: { $regex: subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }, ...v274TranscriptPayloadQuery() })
    .select({ _id: 1, meetingId: 1, transcriptId: 1, subject: 1, startDateTime: 1, endDateTime: 1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary': 1 })
    .sort({ startDateTime: -1 })
    .limit(20)
    .lean();
  let best = null;
  let bestDiff = Infinity;
  for (const t of candidates) {
    const tk = normalizeSubjectKey(t.subject);
    if (!tk || (!tk.includes(subjectKey) && !subjectKey.includes(tk))) continue;
    if (!v293TranscriptLikeMatchesEvent(ev, t)) continue;
    const ts = Date.parse(t.transcriptCreatedDateTime || t.startDateTime || '');
    if (!Number.isFinite(ts)) continue;
    const diff = Math.abs(ts - startMs);
    if (diff < bestDiff && diff <= 6 * 60 * 60 * 1000) { best = t; bestDiff = diff; }
  }
  return best;
}
function transcriptRefFromDoc(doc) {
  if (!doc) return null;
  return {
    transcriptDocId: String(doc._id || ''),
    meetingId: String(doc.meetingId || ''),
    transcriptId: String(doc.transcriptId || ''),
    transcriptCreatedDateTime: String(doc.transcriptCreatedDateTime || ''),
    transcriptStartDateTime: String(doc.transcriptStartDateTime || ''),
    transcriptEndDateTime: String(doc.transcriptEndDateTime || ''),
  };
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

  // v29.3: never trust a cached transcript flag only because the Teams link/event title matched.
  // Validate transcript refs/docs against the actual calendar occurrence time.
  const eventIds = [...new Set(list.map(ev => String(ev?.eventId || ev?.id || '').trim()).filter(Boolean))];
  const refDocIds = [...new Set(list.flatMap(ev => (ev.transcripts || []).map(r => String(r.transcriptDocId || '')).filter(id => mongoose.Types.ObjectId.isValid(id))))];

  const [eventDocs, refDocs] = await Promise.all([
    eventIds.length ? Transcript.find({ orgId, eventId: { $in: eventIds }, ...v274TranscriptPayloadQuery() })
      .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, endDateTime:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary':1 })
      .lean() : [],
    refDocIds.length ? Transcript.find({ orgId, _id: { $in: refDocIds }, ...v274TranscriptPayloadQuery() })
      .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, endDateTime:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary':1 })
      .lean() : [],
  ]);

  const byEvent = new Map();
  for (const d of eventDocs) if (d.eventId && !byEvent.has(String(d.eventId))) byEvent.set(String(d.eventId), d);
  const byRefId = new Map(refDocs.map(d => [String(d._id), d]));

  const needFuzzy = list.filter(ev => {
    const refs = Array.isArray(ev.transcripts) ? ev.transcripts : [];
    const validRef = refs.find(r => v293RefMatchesEvent(ev, r, r.transcriptDocId ? byRefId.get(String(r.transcriptDocId)) : null));
    if (validRef) return false;
    const d = byEvent.get(String(ev.eventId || ev.id || ''));
    return !(d && v293TranscriptLikeMatchesEvent(ev, d));
  });

  const minStart = needFuzzy.reduce((m, ev) => Math.min(m, eventStartMs(ev) || Infinity), Infinity);
  const maxStart = needFuzzy.reduce((m, ev) => Math.max(m, eventStartMs(ev) || 0), 0);
  let fuzzyDocs = [];
  if (needFuzzy.length && Number.isFinite(minStart) && maxStart) {
    const start = new Date(minStart - 6 * 60 * 60 * 1000).toISOString();
    const end = new Date(maxStart + 10 * 60 * 60 * 1000).toISOString();
    fuzzyDocs = await Transcript.find({ orgId, startDateTime: { $gte: start, $lte: end }, ...v274TranscriptPayloadQuery() })
      .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, endDateTime:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary':1 })
      .sort({ startDateTime:-1 })
      .limit(500)
      .lean();
  }

  const updates = [];
  const out = list.map(ev => {
    const refs = Array.isArray(ev.transcripts) ? ev.transcripts : [];
    const validRefs = refs.filter(r => v293RefMatchesEvent(ev, r, r.transcriptDocId ? byRefId.get(String(r.transcriptDocId)) : null));
    if (validRefs.length) return { ...ev, hasTranscript: true, transcripts: validRefs };

    const eid = String(ev?.eventId || ev?.id || '').trim();
    let saved = eid ? byEvent.get(eid) : null;
    if (saved && !v293TranscriptLikeMatchesEvent(ev, saved)) saved = null;

    if (!saved) {
      const subjectKey = normalizeSubjectKey(ev.subject);
      const startMs = eventStartMs(ev);
      if (subjectKey && startMs) {
        let best = null; let bestDiff = Infinity;
        for (const t of fuzzyDocs) {
          const tk = normalizeSubjectKey(t.subject);
          if (!tk || (!tk.includes(subjectKey) && !subjectKey.includes(tk))) continue;
          if (!v293TranscriptLikeMatchesEvent(ev, t)) continue;
          const ts = Date.parse(t.transcriptCreatedDateTime || t.startDateTime || '');
          if (!Number.isFinite(ts)) continue;
          const diff = Math.abs(ts - startMs);
          if (diff < bestDiff && diff <= 6 * 60 * 60 * 1000) { best = t; bestDiff = diff; }
        }
        saved = best;
      }
    }

    if (!saved) {
      if (ev.hasTranscript && ev._id) updates.push({ updateOne: { filter: { _id: ev._id }, update: { $set: { hasTranscript: false, transcripts: [] } } } });
      return { ...ev, hasTranscript: false, transcripts: [] };
    }
    const ref = transcriptRefFromDoc(saved);
    const patched = { ...ev, hasTranscript: true, transcripts: ref ? [ref] : [] };
    if (ev._id) updates.push({ updateOne: { filter: { _id: ev._id }, update: ref ? { $set: { hasTranscript: true, transcripts: [ref] } } : { $set: { hasTranscript: false, transcripts: [] } } } });
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
  const graphRefs = (ev._transcripts || []).map(t => v293TranscriptRefFromGraph(t.meetingId, t)).filter(t => t && (t.meetingId || t.transcriptId));
  const existing = eventId ? await EventCache.findOne({ orgId, userEmail, eventId }).select({ hasTranscript:1, transcripts:1, linkedThreadId:1, linkedThreadName:1, aiIndexStatus:1 }).lean() : null;
  const endMs = Date.parse(toIsoZ(ev.end || ev.endDateTime) || toIsoZ(ev.start || ev.startDateTime) || '');
  const isFutureOrLive = Number.isFinite(endMs) && endMs > Date.now();
  // v29.1: upcoming refresh should stay fast and future events should not inherit transcript flags from duplicated meetings.
  // Saved transcript fuzzy matching is only useful after a meeting has ended.
  const saved = isFutureOrLive ? null : await findSavedTranscriptForEvent(orgId, ev);
  const savedRef = transcriptRefFromDoc(saved);
  const safeExistingRefs = isFutureOrLive ? [] : await v293SafeExistingRefsForEvent(orgId, ev, existing?.transcripts || []);
  const refs = graphRefs.length ? graphRefs : (savedRef ? [savedRef] : safeExistingRefs);
  const hasTranscript = !isFutureOrLive && !!(refs && refs.length);
  return {
    orgId,
    userEmail,
    eventId,
    iCalUId: String(ev.iCalUId || ev.icalUId || ev.iCalUid || ev.uid || ''),
    seriesMasterId: String(ev.seriesMasterId || ev.recurringSeriesMasterId || ''),
    importedSource: ev.importedSource || '',
    subject: ev.subject || '',
    startDateTime: toIsoZ(ev.start || ev.startDateTime),
    endDateTime: toIsoZ(ev.end || ev.endDateTime),
    location: ev.location?.displayName || ev.location || '',
    bodyPreview: String(ev.bodyPreview || ev.body?.content || ev.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
    organizerEmail: String(orgEmail || '').toLowerCase().trim(),
    attendeeEmails: uniqEmails,
    hasTranscript,
    aiIndexStatus: hasTranscript ? (existing?.aiIndexStatus || 'not_loaded') : 'not_loaded',
    transcripts: refs,
    syncedAt: new Date(),
  };
}

// v27: intentionally simple user-side meeting hub helpers.
const V27_MEETING_WINDOW_DAYS = 60;
const V27_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function v27Date(value) {
  const d = value ? new Date(value) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}
function v27FmtDate(d, opts) {
  try { return new Intl.DateTimeFormat('en-IN', { timeZone: V27_TZ, ...opts }).format(d); }
  catch (e) { return new Intl.DateTimeFormat('en-IN', opts).format(d); }
}
function v27MeetingLabels(start, end) {
  const s = v27Date(start);
  const e = v27Date(end);
  if (!s) return { dayNumber: '—', monthLabel: '', dateLabel: 'Time not available', timeLabel: '' };
  const dayNumber = v27FmtDate(s, { day: '2-digit' });
  const monthLabel = v27FmtDate(s, { month: 'short' }).toUpperCase();
  const dateLabel = v27FmtDate(s, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const st = v27FmtDate(s, { hour: 'numeric', minute: '2-digit', hour12: true });
  const et = e ? v27FmtDate(e, { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  return { dayNumber, monthLabel, dateLabel, timeLabel: et ? `${st} - ${et}` : st };
}
function v27LastSyncLabel(value) {
  const d = v27Date(value);
  if (!d) return '';
  return v27FmtDate(d, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}
function v27FirstTranscriptRef(ev) {
  const refs = Array.isArray(ev?.transcripts) ? ev.transcripts : [];
  return refs.find(r => r && (r.transcriptDocId || (r.meetingId && r.transcriptId))) || null;
}
function v27EnsureTranscriptHref(ev, ref, summary = false) {
  if (!ref?.meetingId || !ref?.transcriptId) return '';
  const params = new URLSearchParams();
  if (ev.eventId) params.set('eventId', ev.eventId);
  if (ev.subject) params.set('subject', ev.subject);
  if (ev.startDateTime) params.set('start', ev.startDateTime);
  if (ev.endDateTime) params.set('end', ev.endDateTime);
  if (summary) params.set('summary', '1');
  return `/user/transcript/ensure/${encodeURIComponent(ref.meetingId)}/${encodeURIComponent(ref.transcriptId)}?${params.toString()}`;
}
function v27HasTranscriptPayload(doc) {
  return !!(doc && (String(doc.text || '').trim() || String(doc.vtt || '').trim()));
}
function v274TranscriptPayloadQuery() {
  return {
    $or: [
      { text: { $exists: true, $ne: '' } },
      { vtt: { $exists: true, $ne: '' } },
      { transcriptId: { $exists: true, $ne: '' } },
      { 'ai.summary': { $exists: true, $ne: '' } },
    ],
  };
}

function v292WithTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took too long. Please try again; cached meetings are still available.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function buildCachePayloadFast(orgId, userEmail, ev) {
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
  const graphRefs = (ev._transcripts || []).map(t => v293TranscriptRefFromGraph(t.meetingId, t)).filter(t => t && (t.meetingId || t.transcriptId));
  const existing = eventId ? await EventCache.findOne({ orgId, userEmail, eventId }).select({ hasTranscript:1, transcripts:1, linkedThreadId:1, linkedThreadName:1, aiIndexStatus:1 }).lean() : null;
  const endMs = Date.parse(toIsoZ(ev.end || ev.endDateTime) || toIsoZ(ev.start || ev.startDateTime) || '');
  const isFutureOrLive = Number.isFinite(endMs) && endMs > Date.now();
  const existingRefs = !isFutureOrLive && existing?.hasTranscript ? await v293SafeExistingRefsForEvent(orgId, ev, existing.transcripts || []) : [];
  const refs = graphRefs.length ? graphRefs : existingRefs;
  const hasTranscript = !isFutureOrLive && !!(refs && refs.length);
  return {
    orgId,
    userEmail,
    eventId,
    iCalUId: String(ev.iCalUId || ev.icalUId || ev.icalUid || ev.uid || ''),
    seriesMasterId: String(ev.seriesMasterId || ev.recurringSeriesMasterId || ''),
    importedSource: ev.importedSource || '',
    subject: ev.subject || '',
    startDateTime: toIsoZ(ev.start || ev.startDateTime),
    endDateTime: toIsoZ(ev.end || ev.endDateTime),
    location: ev.location?.displayName || ev.location || '',
    bodyPreview: String(ev.bodyPreview || ev.body?.content || ev.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
    organizerEmail: String(orgEmail || '').toLowerCase().trim(),
    attendeeEmails: uniqEmails,
    hasTranscript,
    aiIndexStatus: hasTranscript ? (existing?.aiIndexStatus || 'not_loaded') : 'not_loaded',
    transcripts: refs,
    linkedThreadId: existing?.linkedThreadId || null,
    linkedThreadName: existing?.linkedThreadName || '',
  };
}
async function v27RefreshMeetingCache(req, res, pastStart, pastEnd) {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();
  if (!accessToken) throw new Error('No Microsoft access token available. Please sign in again.');

  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();

  // v29.2: keep Outlook refresh bounded. Transcript discovery can be slow on Graph,
  // so we fetch calendar metadata first and transcript-check only a small recent slice.
  const pastList = await v292WithTimeout(getCalendarRange(accessToken, {
    startDateTime: pastStart.toISOString(),
    endDateTime: pastEnd.toISOString(),
    top: 75,
    max: 260,
  }), 18000, 'Outlook calendar refresh');

  const events = (Array.isArray(pastList) ? pastList : [])
    .filter(ev => ev && !ev.isCancelled && String(ev.subject || '').trim());
  const endedOnline = events.filter(ev => {
    const endMs = Date.parse(toIsoZ(ev.end || ev.endDateTime) || toIsoZ(ev.start || ev.startDateTime) || '');
    return Number.isFinite(endMs) && endMs <= Date.now() && !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl);
  });

  let annotated = events;
  if (endedOnline.length) {
    try {
      const checked = await v292WithTimeout(
        annotateEventsWithTranscripts(accessToken, endedOnline, { maxChecks: 55, concurrency: 3 }),
        22000,
        'Transcript availability check'
      );
      const checkedById = new Map((Array.isArray(checked) ? checked : []).map(ev => [String(ev.id || ev.eventId || ''), ev]));
      annotated = events.map(ev => checkedById.get(String(ev.id || ev.eventId || '')) || ev);
    } catch (e) {
      console.warn('[v29.2 refresh] transcript check skipped:', e.message || String(e));
      annotated = events;
    }
  }

  if (annotated.length) {
    const bulk = EventCache.collection.initializeUnorderedBulkOp();
    let ops = 0;
    for (const ev of annotated) {
      const payload = await buildCachePayloadFast(orgId, me, ev);
      if (!payload?.eventId || !payload?.startDateTime) continue;
      bulk.find({ orgId, userEmail: me, eventId: payload.eventId }).upsert().updateOne({
        $set: { ...payload, syncedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      });
      ops++;
    }
    if (ops > 0) await bulk.execute();
  }
}

async function v27BuildMeetingCards(req, pastStart, pastEnd) {
  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const principals = getUserPrincipals(req.user);

  const nowMs = Date.now();
  let cached = await EventCache.find({
    orgId,
    userEmail: me,
    startDateTime: { $gte: pastStart.toISOString(), $lte: pastEnd.toISOString() },
  })
    .select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1, location:1, organizerEmail:1, hasTranscript:1, transcripts:1 })
    .sort({ startDateTime: -1 })
    .limit(500)
    .lean();
  cached = await hydrateCachedTranscriptFlags(orgId, cached);
  // v28.5: do not show transcript-ready labels for meetings that have not ended yet.
  cached = cached.filter(e => {
    const endMs = Date.parse(e.endDateTime || e.startDateTime || '');
    return e.hasTranscript && Number.isFinite(endMs) && endMs <= nowMs;
  });

  const eventIds = [...new Set(cached.map(e => String(e.eventId || '')).filter(Boolean))];
  const refDocIds = [...new Set(cached.flatMap(e => (e.transcripts || []).map(r => String(r.transcriptDocId || '')).filter(Boolean)))];

  const or = [];
  if (eventIds.length) or.push({ eventId: { $in: eventIds } });
  if (refDocIds.length) {
    const validIds = refDocIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length) or.push({ _id: { $in: validIds } });
  }

  const transcriptDocs = or.length ? await Transcript.find({ orgId, $or: or })
    .select({ _id:1, eventId:1, meetingId:1, transcriptId:1, subject:1, startDateTime:1, endDateTime:1, participantEmails:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary':1, 'ai.status':1 })
    .lean() : [];

  const byEvent = new Map();
  const byId = new Map();
  for (const d of transcriptDocs) {
    byId.set(String(d._id), d);
    if (d.eventId && !byEvent.has(String(d.eventId))) byEvent.set(String(d.eventId), d);
  }

  const seenDocIds = new Set();
  const staleEventIds = [];
  const cards = cached.map(ev => {
    const ref = v27FirstTranscriptRef(ev);
    let doc = (ref?.transcriptDocId && byId.get(String(ref.transcriptDocId))) || byEvent.get(String(ev.eventId || '')) || null;
    if (doc && !v293TranscriptLikeMatchesEvent(ev, doc)) doc = null;
    if (!doc && ref && !v293RefMatchesEvent(ev, ref, null)) {
      if (ev._id) staleEventIds.push(ev._id);
      return null;
    }
    if (!doc && !ref) return null;
    if (doc?._id) seenDocIds.add(String(doc._id));
    const labels = v27MeetingLabels(ev.startDateTime, ev.endDateTime);
    const transcriptHref = doc?._id ? `/user/transcript/saved/${doc._id}` : v27EnsureTranscriptHref(ev, ref, false);
    const summaryHref = doc?._id ? `/user/transcript/saved/${doc._id}/summary` : v27EnsureTranscriptHref(ev, ref, true);
    return {
      id: String(ev._id || ev.eventId || Math.random()),
      eventId: ev.eventId || '',
      subject: ev.subject || doc?.subject || 'Untitled meeting',
      startMs: Date.parse(ev.startDateTime || doc?.startDateTime || '') || 0,
      startDateTime: ev.startDateTime || doc?.startDateTime || '',
      endDateTime: ev.endDateTime || doc?.endDateTime || '',
      location: ev.location || '',
      organizerEmail: ev.organizerEmail || '',
      transcriptHref,
      summaryHref,
      summaryLabel: doc?.ai?.summary ? 'AI Summary' : 'Generate summary',
      summaryReady: !!doc?.ai?.summary,
      sourceLabel: doc?.ai?.summary ? 'Summary ready' : 'Transcript ready',
      ...labels,
    };
  }).filter(Boolean);
  if (staleEventIds.length) {
    EventCache.updateMany({ _id: { $in: staleEventIds } }, { $set: { hasTranscript: false, transcripts: [] } }).catch(()=>{});
  }

  // Also include saved transcripts from the last 60 days even if they are not in EventCache.
  const savedDocs = await Transcript.find({
    orgId,
    'acl.allowedEmails': { $in: principals },
    startDateTime: { $gte: pastStart.toISOString(), $lte: pastEnd.toISOString() },
    ...v274TranscriptPayloadQuery(),
  })
    .select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1, participantEmails:1, transcriptCreatedDateTime:1, transcriptStartDateTime:1, transcriptEndDateTime:1, 'ai.summary':1, 'ai.status':1 })
    .sort({ startDateTime:-1, createdAt:-1 })
    .limit(400)
    .lean();

  for (const doc of savedDocs) {
    if (seenDocIds.has(String(doc._id))) continue;
    const labels = v27MeetingLabels(doc.startDateTime, doc.endDateTime);
    seenDocIds.add(String(doc._id));
    cards.push({
      id: String(doc._id),
      eventId: doc.eventId || '',
      transcriptDocId: String(doc._id),
      subject: doc.subject || 'Saved transcript',
      startMs: Date.parse(doc.startDateTime || '') || 0,
      startDateTime: doc.startDateTime || '',
      endDateTime: doc.endDateTime || '',
      location: '',
      organizerEmail: '',
      transcriptHref: `/user/transcript/saved/${doc._id}`,
      summaryHref: `/user/transcript/saved/${doc._id}/summary`,
      summaryLabel: doc?.ai?.summary ? 'AI Summary' : 'Generate summary',
      summaryReady: !!doc?.ai?.summary,
      sourceLabel: doc?.ai?.summary ? 'Summary ready' : 'Saved transcript',
      ...labels,
    });
  }

  return cards.sort((a,b) => (b.startMs || 0) - (a.startMs || 0));
}


function v272NormalizeSearch(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function v272FilterMeetingCards(cards, q) {
  const query = v272NormalizeSearch(q);
  if (!query) return cards;
  const terms = query.split(' ').filter(Boolean);
  return (cards || []).filter(m => {
    const haystack = v272NormalizeSearch([
      m.subject,
      m.dateLabel,
      m.timeLabel,
      m.location,
      m.organizerEmail,
      m.sourceLabel,
    ].filter(Boolean).join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

function v272SafeFilename(value, fallback = 'meeting') {
  const clean = String(value || fallback)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return clean || fallback;
}

function v272DownloadDateLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || '');
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function v280MailDateLabel(value) {
  if (!value) return 'Date unavailable';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || 'Date unavailable');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function v280FoldBase64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim();
}

function v280HeaderSafe(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function v280BuildTranscriptEmail(doc) {
  const meetingSubject = v280HeaderSafe(doc.subject || 'Meeting transcript');
  const dateLabel = v280MailDateLabel(doc.startDateTime);
  const subject = `${meetingSubject} || ${dateLabel}`;
  const transcriptBody = [
    `Meeting: ${doc.subject || 'Meeting transcript'}`,
    doc.startDateTime ? `Date: ${v272DownloadDateLabel(doc.startDateTime)}` : '',
    '',
    'Transcript',
    '==========',
    '',
    String(doc.text || doc.vtt || 'No transcript text found in this saved record.'),
  ].filter(x => x !== '').join('\n');
  const attachmentName = `${v272SafeFilename(doc.subject || 'meeting')}-transcript.txt`;
  const boundary = `ms-minutes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const lines = [
    'From: ',
    'To: ',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    `Hi,`,
    '',
    `Please find attached the transcript for: ${doc.subject || 'Meeting'}`,
    doc.startDateTime ? `Date: ${v272DownloadDateLabel(doc.startDateTime)}` : '',
    '',
    'Regards,',
    'Ms. Minutes',
    '',
    `--${boundary}`,
    `Content-Type: text/plain; name="${attachmentName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    '',
    v280FoldBase64(transcriptBody),
    '',
    `--${boundary}--`,
    '',
  ];
  return { subject, filename: `${v272SafeFilename(subject || 'email')}.eml`, eml: lines.join('\r\n') };
}

function v278MeetingDurationMinutes(doc) {
  const start = doc?.startDateTime ? Date.parse(doc.startDateTime) : NaN;
  const end = doc?.endDateTime ? Date.parse(doc.endDateTime) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.max(1, Math.round((end - start) / 60000));
  return 0;
}
function v278SummaryLineCount(doc) {
  const mins = v278MeetingDurationMinutes(doc);
  return Math.max(2, Math.round((mins || 20) / 10));
}
async function v278FindRecurringMeetingsForDocs(req, docs, limit = 80) {
  const principals = getUserPrincipals(req.user);
  const selected = (docs || []).filter(Boolean);
  const keys = [...new Set(selected.map(d => normalizeThreadTitle(d.subject || '')).filter(k => k && k.length >= 4))];
  if (!keys.length) return [];
  const start = new Date();
  start.setDate(start.getDate() - 365);
  const candidates = await Transcript.find({
    orgId: req.user.org._id,
    'acl.allowedEmails': { $in: principals },
    startDateTime: { $gte: start.toISOString() },
    ...v274TranscriptPayloadQuery(),
  }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, acl:1 }).sort({ startDateTime:-1 }).limit(700).lean();
  const selectedIds = new Set(selected.map(d => String(d._id)));
  const matched = [];
  for (const c of candidates) {
    if (selectedIds.has(String(c._id))) continue;
    const ck = normalizeThreadTitle(c.subject || '');
    if (!ck) continue;
    const ok = keys.some(k => {
      if (ck === k || ck.includes(k) || k.includes(ck)) return true;
      const a = new Set(k.split(' ').filter(w => w.length >= 3));
      const b = new Set(ck.split(' ').filter(w => w.length >= 3));
      const inter = [...a].filter(x => b.has(x)).length;
      return inter >= Math.min(3, Math.max(2, Math.ceil(Math.min(a.size, b.size) * 0.6)));
    });
    if (ok) matched.push(c);
    if (matched.length >= limit) break;
  }
  return matched;
}
async function v278LinkDocsToThread(req, thread, docs, { recurring = false } = {}) {
  const baseDocs = (docs || []).filter(Boolean);
  let allDocs = baseDocs;
  if (recurring) {
    const recurringDocs = await v278FindRecurringMeetingsForDocs(req, baseDocs);
    allDocs = [...baseDocs, ...recurringDocs];
  }
  const byId = new Map(allDocs.map(d => [String(d._id), d]));
  const finalDocs = [...byId.values()];
  if (!finalDocs.length) return { count: 0, recurringCount: 0 };
  const aclExtra = uniqEmails(finalDocs.flatMap(d => d.acl?.allowedEmails || []));
  await MeetingThread.updateOne(
    { _id: thread._id, orgId: req.user.org._id },
    {
      $addToSet: {
        meetingIds: { $each: finalDocs.map(d => d._id) },
        'acl.allowedEmails': { $each: aclExtra },
      },
      $set: recurring ? {
        'recurringChain.enabled': true,
        'recurringChain.matchMode': 'subject',
        'recurringChain.subjectKey': normalizeThreadTitle(baseDocs[0]?.subject || thread.name || ''),
        'recurringChain.lastConnectedAt': new Date(),
        'recurringChain.connectedCount': finalDocs.length,
        'acl.updatedAt': new Date(),
        updatedAt: new Date(),
      } : { 'acl.updatedAt': new Date(), updatedAt: new Date() },
      $push: { entries: {
        kind: 'meeting',
        sourceType: recurring ? 'Teams meeting' : 'Manual meeting',
        visibility: 'thread',
        title: recurring ? `Linked ${finalDocs.length} meeting(s), including recurring matches` : `Linked ${finalDocs.length} meeting(s)`,
        body: finalDocs.slice(0, 8).map(d => d.subject || 'Meeting').join('; ') + (finalDocs.length > 8 ? `; and ${finalDocs.length - 8} more` : ''),
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      } },
    }
  );
  return { count: finalDocs.length, recurringCount: Math.max(0, finalDocs.length - baseDocs.length) };
}

function v273EscapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function v291StripOwnerLabels(line) {
  return String(line || '')
    .replace(/\[\s*Owner\s*:\s*[^\]]+\]\s*/gi, '')
    .replace(/\(\s*Owner\s*:\s*[^;)]+;\s*Due\s*:\s*([^\)]+)\)/gi, '(Due: $1)')
    .replace(/\(\s*Due\s*:\s*([^;)]+);\s*Owner\s*:\s*[^\)]+\)/gi, '(Due: $1)')
    .replace(/\(\s*Owner\s*:\s*[^\)]+\)/gi, '')
    .replace(/\s+Owner\s*:\s*[^.;\n]+\.?\s*/gi, ' ')
    .replace(/—\s*Owner\s*:\s*[^;\n]+;\s*/gi, '— ')
    .replace(/;\s*Owner\s*:\s*[^;\n]+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function v273InlineClean(line) {
  return v291StripOwnerLabels(String(line || ''))
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function v273InlineHtml(line) {
  const escaped = v273EscapeHtml(v291StripOwnerLabels(String(line || '').replace(/`([^`]+)`/g, '$1')));
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\s+/g, ' ')
    .trim();
}

function v272SummarySections(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  function startSection(title) {
    const cleanTitle = v273InlineClean(title || 'Summary').replace(/:$/, '').trim();
    current = {
      title: cleanTitle || 'Summary',
      isTasks: /follow[- ]?up|action item|task|^actions$/i.test(cleanTitle || ''),
      rows: [],
    };
    sections.push(current);
  }

  for (const original of lines) {
    let line = String(original || '').trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/) || line.match(/^\*\*(.+?)\*\*:?$/);
    if (heading) {
      startSection(heading[1]);
      continue;
    }

    if (/^summary:?$/i.test(line)) {
      startSection('Summary');
      continue;
    }
    if (/^actions:?$/i.test(line) || /^follow[- ]?up tasks:?$/i.test(line) || /^action items:?$/i.test(line)) {
      startSection('Actions');
      continue;
    }
    if (/^detailed notes:?$/i.test(line)) {
      startSection('Detailed notes');
      continue;
    }
    if (/^meeting notes:?$/i.test(line)) {
      startSection('Detailed notes');
      continue;
    }

    if (/^Generated by AI/i.test(line) || /^Make sure to check for accuracy/i.test(line)) {
      continue;
    }

    if (!current) startSection('Meeting notes');

    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      const body = bullet[1].trim();
      current.rows.push({ type: 'bullet', text: v273InlineClean(body), html: v273InlineHtml(body) });
      continue;
    }

    const isTopic = /^\*\*.+?\*\*\s*:/.test(line) || /^[A-Z][^.!?]{8,90}:$/.test(line);
    current.rows.push({
      type: isTopic ? 'topic' : 'text',
      text: v273InlineClean(line),
      html: v273InlineHtml(line),
    });
  }

  return sections.filter(section => section.rows.length);
}

async function v272LoadTranscriptForUser(req, id) {
  const doc = await Transcript.findById(id);
  if (!doc) return null;
  if (String(doc.orgId) !== String(req.user.org?._id)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return doc;
}

async function v272EnsureSummaryForDoc(doc, options = {}) {
  if (!doc) return doc;
  const force = !!options.force;
  if (!force && (doc.ai?.summary || !String(doc.text || '').trim())) return doc;
  if (!String(doc.text || '').trim()) return doc;
  try {
    await Transcript.updateOne(
      { _id: doc._id },
      { $set: { 'ai.status': 'queued', 'ai.error': '', 'ai.updatedAt': new Date() } }
    );
    const { model, summary } = await generateMeetingSummary({
      text: doc.text || '',
      subject: doc.subject || '',
      startDateTime: doc.startDateTime || '',
      endDateTime: doc.endDateTime || '',
      durationMinutes: v278MeetingDurationMinutes(doc),
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
    return Transcript.findById(doc._id);
  } catch (e) {
    await Transcript.updateOne(
      { _id: doc._id },
      { $set: { 'ai.status': 'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() } }
    );
    return Transcript.findById(doc._id);
  }
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



// GET /user/home
// Simple v1 landing page: keep the same auth, models, and MongoDB, but make the
// first post-login screen intentionally light.
router.get('/home', requireUser, async (req, res, next) => {
  try {
    const orgId = req.user.org._id;
    const userEmail = String(req.user.email || '').toLowerCase().trim();
    const principals = getUserPrincipals(req.user);

    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    const nextThreeDaysEnd = addDays(now, 3);
    const [todayMeetingCount, recentMeetingCount, threadCount, pendingActionCount, transcriptCount, nextMeetingCount, summaryCount, threadContextCount] = await Promise.all([
      EventCache.countDocuments({
        orgId,
        userEmail,
        startDateTime: { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() },
      }),
      EventCache.countDocuments({ orgId, userEmail }),
      MeetingThread.countDocuments(threadAccessQuery(req)),
      ActionItem.countDocuments({
        orgId,
        status: { $nin: ['Done', 'Dropped'] },
        ...actionOwnerScopeForUser(req.user),
      }),
      Transcript.countDocuments({ orgId, 'acl.allowedEmails': { $in: principals } }),
      EventCache.countDocuments({
        orgId,
        userEmail,
        startDateTime: { $gte: now.toISOString(), $lte: nextThreeDaysEnd.toISOString() },
      }),
      Transcript.countDocuments({ orgId, 'acl.allowedEmails': { $in: principals }, 'ai.summary': { $exists: true, $ne: '' } }),
      MeetingThread.countDocuments({ ...threadAccessQuery(req), 'entries.1': { $exists: true } }),
    ]);

    const cards = [
      {
        key: 'meetings',
        icon: '📅',
        title: 'Meetings',
        text: 'View calendar meetings, transcripts, notes, summaries, and meeting-level actions.',
        href: '/user/meetings',
        stat: todayMeetingCount ? `${todayMeetingCount} today` : `${recentMeetingCount} synced`,
        cta: 'Open meetings',
      },
      {
        key: 'threads',
        icon: '🧵',
        title: 'Threads',
        text: 'Track outcome-based workstreams across related meetings, decisions, blockers, and follow-ups.',
        href: '/user/threads',
        stat: `${threadCount} active`,
        cta: 'Open threads',
      },
      {
        key: 'intelligence',
        icon: '✨',
        title: 'Intelligence',
        text: 'Prepare for upcoming meetings using linked threads and recent related meeting memory.',
        href: '/user/intelligence',
        stat: nextMeetingCount ? `${nextMeetingCount} upcoming` : `${transcriptCount} memories`,
        cta: 'Open intelligence',
      },
      {
        key: 'recall',
        icon: '🔎',
        title: 'What did I discuss?',
        text: 'Search your meeting memory by topic, time range, notes, transcripts and threads.',
        href: '/user/recall',
        stat: 'topic recall',
        cta: 'Ask memory',
      },
      {
        key: 'assistant',
        icon: '🗒️',
        title: 'Assistant Desk',
        text: 'Add and receive prep notes, questions to ask, reminders and watchouts for key people.',
        href: '/user/assistant',
        stat: 'delegated prep',
        cta: 'Open desk',
      },
    ];

    return res.render('user/home', {
      title: 'Meeting Hub',
      activeNav: 'home',
      fullBleed: true,
      user: req.user,
      org: req.user.org,
      cards,
      onboarding: {
        hasMeetings: recentMeetingCount > 0,
        hasTranscript: transcriptCount > 0,
        hasSummary: summaryCount > 0,
        hasThread: threadCount > 0,
        hasContext: threadContextCount > 0,
      },
    });
  } catch (e) {
    return next(e);
  }
});

// Friendly top-level aliases for the simplified v1 home.

function v275MeetingCacheKey(req, pastStart, pastEnd) {
  return [
    String(req.user.org?._id || ''),
    String(req.user._id || ''),
    String(req.user.email || '').toLowerCase(),
    pastStart.toISOString().slice(0, 10),
    pastEnd.toISOString().slice(0, 10),
  ].join(':');
}
function v275ClearMeetingCache(req) {
  global.__msMinutesMeetingCache = global.__msMinutesMeetingCache || new Map();
  for (const key of global.__msMinutesMeetingCache.keys()) {
    if (key.startsWith(`${String(req.user.org?._id || '')}:${String(req.user._id || '')}:`)) {
      global.__msMinutesMeetingCache.delete(key);
    }
  }
}
async function v275GetCachedMeetingCards(req, pastStart, pastEnd) {
  global.__msMinutesMeetingCache = global.__msMinutesMeetingCache || new Map();
  const key = v275MeetingCacheKey(req, pastStart, pastEnd);
  const cached = global.__msMinutesMeetingCache.get(key);
  const ttlMs = Math.max(5000, Number(process.env.MEETING_CARD_CACHE_MS || 45000));
  if (cached && (Date.now() - cached.at) < ttlMs) return cached.cards;
  const cards = await v27BuildMeetingCards(req, pastStart, pastEnd);
  global.__msMinutesMeetingCache.set(key, { at: Date.now(), cards });
  return cards;
}

async function v274MeetingPageData(req, page, pageSize, q) {
  const now = new Date();
  const pastStart = new Date(now);
  pastStart.setDate(now.getDate() - (V27_MEETING_WINDOW_DAYS - 1));
  pastStart.setHours(0, 0, 0, 0);
  const pastEnd = new Date(now);

  const allMeetings = await v275GetCachedMeetingCards(req, pastStart, pastEnd);
  const filteredMeetings = v272FilterMeetingCards(allMeetings, q);
  const offset = Math.max(0, (page - 1) * pageSize);
  const meetings = filteredMeetings.slice(offset, offset + pageSize);
  const hasMore = filteredMeetings.length > offset + pageSize;
  return { meetings, hasMore, nextPage: page + 1, totalMeetingCount: allMeetings.length, filteredMeetingCount: filteredMeetings.length };
}


router.post('/meetings/import-ics', requireUser, calendarImportUpload.single('calendarFile'), async (req, res, next) => {
  try {
    if (!req.file) return res.redirect(req.body.returnTo || '/user/meetings');
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const parsed = v29ParseIcs(raw);
    if (!parsed.subject || !parsed.startDateTime) throw new Error('Could not read meeting title/start time from the .ics file.');
    const me = String(req.user.email || '').toLowerCase().trim();
    const eventId = `ics:${parsed.uid}`;
    const payload = {
      orgId: req.user.org._id,
      userEmail: me,
      eventId,
      iCalUId: parsed.uid,
      subject: parsed.subject,
      startDateTime: parsed.startDateTime,
      endDateTime: parsed.endDateTime,
      location: parsed.location,
      bodyPreview: parsed.description,
      importedSource: 'ics',
      importedAt: new Date(),
      importedByEmail: me,
      hasTranscript: false,
      syncedAt: new Date(),
    };
    const threadId = String(req.body.threadId || '').trim();
    let thread = null;
    if (mongoose.Types.ObjectId.isValid(threadId)) {
      thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: threadId });
      if (thread && canContributeThread(req, thread)) {
        payload.linkedThreadId = thread._id;
        payload.linkedThreadName = thread.name || '';
      }
    }
    await EventCache.findOneAndUpdate({ orgId: req.user.org._id, userEmail: me, eventId }, { $set: payload, $setOnInsert: { createdAt: new Date() } }, { upsert: true, new: true });
    if (thread && canContributeThread(req, thread)) {
      await MeetingThread.updateOne({ _id: thread._id }, {
        $push: { entries: { kind:'meeting', sourceType:'Manual meeting', visibility:'thread', title:'Imported calendar invite', body:[`Meeting: ${parsed.subject}`, parsed.startDateTime ? `When: ${v276ThreadUpdatedLabel(parsed.startDateTime)}` : '', parsed.location ? `Where: ${parsed.location}` : '', parsed.description ? `Notes: ${parsed.description}` : ''].filter(Boolean).join('\n'), createdBy:req.user._id, createdByEmail:req.user.email, createdAt:new Date() } },
        $set: { updatedAt: new Date() }
      });
    }
    v275ClearMeetingCache(req);
    return res.redirect(req.body.returnTo || (thread ? `/user/threads/${thread._id}` : '/user/intelligence'));
  } catch (e) { return next(e); }
});

router.post('/meetings/:eventId/check-transcript', requireUser, ensureUserFreshToken, async (req, res, next) => {
  try {
    const eventId = String(req.params.eventId || '').trim();
    const me = String(req.user.email || '').toLowerCase().trim();
    const cached = await EventCache.findOne({ orgId:req.user.org._id, userEmail:me, eventId }).lean();
    if (!cached) return res.redirect('/user/meetings?checked=notfound');
    const start = new Date(cached.startDateTime || Date.now());
    const end = new Date(cached.endDateTime || cached.startDateTime || Date.now());
    if (!Number.isFinite(start.getTime())) return res.redirect('/user/meetings?checked=badtime');
    const from = new Date(start.getTime() - 2 * 60 * 60 * 1000);
    const to = new Date((Number.isFinite(end.getTime()) ? end.getTime() : start.getTime()) + 8 * 60 * 60 * 1000);
    const accessToken = (res.locals.userTokens?.access_token || '').trim();
    if (!accessToken) throw new Error('No Microsoft access token available. Please sign in again.');
    const events = await getCalendarRange(accessToken, { startDateTime:from.toISOString(), endDateTime:to.toISOString(), top:30, max:80 });
    const matched = (Array.isArray(events) ? events : []).find(ev => String(ev.id || ev.eventId || '') === eventId) || (Array.isArray(events) ? events : []).find(ev => String(toIsoZ(ev.start || ev.startDateTime)) === String(cached.startDateTime) && String(ev.subject || '') === String(cached.subject || ''));
    if (!matched) return res.redirect('/user/meetings?checked=eventnotfound');
    const annotated = await annotateEventsWithTranscripts(accessToken, [matched], { maxChecks:1, concurrency:1 });
    const payload = await buildCachePayloadFast(req.user.org._id, me, (annotated && annotated[0]) || matched);
    await EventCache.updateOne({ orgId:req.user.org._id, userEmail:me, eventId }, { $set:{ ...payload, syncedAt:new Date() } });
    v275ClearMeetingCache(req);
    return res.redirect('/user/meetings?checked=' + (payload.hasTranscript ? 'ready' : 'notready'));
  } catch(e) { return next(e); }
});

router.get('/meetings/data', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const pageSize = Math.min(30, Math.max(9, Number(req.query.limit || 18) || 18));
    const data = await v274MeetingPageData(req, page, pageSize, q);
    return res.json({ ok: true, q, page, pageSize, windowDays: V27_MEETING_WINDOW_DAYS, ...data });
  } catch (e) {
    return next(e);
  }
});

router.get('/meetings', requireUser, ensureUserFreshToken, async (req, res, next) => {
  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const now = new Date();
  const pastStart = new Date(now);
  pastStart.setDate(now.getDate() - (V27_MEETING_WINDOW_DAYS - 1));
  pastStart.setHours(0, 0, 0, 0);
  const pastEnd = new Date(now);

  let error = null;
  let refreshed = false;
  try {
    if (String(req.query.refresh || '') === '1') {
      await v27RefreshMeetingCache(req, res, pastStart, pastEnd);
      v275ClearMeetingCache(req);
      refreshed = true;
    }
  } catch (e) {
    error = e.message || String(e);
    if (/InvalidAuthenticationToken|Lifetime validation failed|token is expired/i.test(error)) {
      req.session.userTokens = null;
      error = 'Your Microsoft session expired. Please sign in again, then refresh meetings.';
    }
  }

  try {
    const q = String(req.query.q || '').trim();
    const page = 1;
    const pageSize = Math.min(30, Math.max(9, Number(req.query.limit || 18) || 18));
    const data = await v274MeetingPageData(req, page, pageSize, q);

    const lastCached = await EventCache.findOne({ orgId, userEmail: me })
      .sort({ syncedAt: -1 })
      .select({ syncedAt: 1 })
      .lean();

    const lastSyncMs = lastCached?.syncedAt ? new Date(lastCached.syncedAt).getTime() : NaN;
    const syncAgeDays = Number.isFinite(lastSyncMs) ? Math.floor((Date.now() - lastSyncMs) / 86400000) : null;
    const refreshState = syncAgeDays === null
      ? { mode: 'force', days: null, title: 'Let’s freshen this up 🐥', message: 'Ms. Minutes has not refreshed your Outlook meetings yet. Please refresh once so this page can show your latest transcript meetings.' }
      : syncAgeDays >= 14
        ? { mode: 'force', days: syncAgeDays, title: 'Refresh required 🐣', message: `Your meeting list is ${syncAgeDays} days old. Please refresh from Outlook before continuing.` }
        : syncAgeDays >= 7
          ? { mode: 'warn', days: syncAgeDays, title: 'Tiny refresh nudge 🐥', message: `Your meeting list is ${syncAgeDays} days old. A quick Outlook refresh will keep summaries and threads accurate.` }
          : null;

    return res.render('user/meetings', {
      title: 'Meetings',
      fullBleed: true,
      user: req.user,
      org: req.user.org,
      meetings: data.meetings,
      q,
      page,
      pageSize,
      hasMore: data.hasMore,
      nextPage: data.nextPage,
      totalMeetingCount: data.totalMeetingCount,
      filteredMeetingCount: data.filteredMeetingCount,
      windowDays: V27_MEETING_WINDOW_DAYS,
      error,
      refreshed,
      lastSyncedAt: lastCached?.syncedAt || null,
      lastSyncedAtLabel: v27LastSyncLabel(lastCached?.syncedAt),
      refreshState,
    });
  } catch (e) {
    return next(e);
  }
});

// Keep the simplified v27 surface. Old heavy user pages are intentionally not linked.
router.get('/calendar', requireUser, (req, res) => res.redirect('/user/meetings'));

function v276ThreadStatusMeta(status) {
  const s = String(status || 'Active');
  if (/blocked/i.test(s)) return { label: 'Blocked', tone: 'blocked' };
  if (/risk/i.test(s)) return { label: 'At Risk', tone: 'risk' };
  if (/closed/i.test(s)) return { label: 'Closed', tone: 'closed' };
  return { label: 'Active', tone: 'active' };
}
function v276EntryCounts(thread) {
  const entries = Array.isArray(thread?.entries) ? thread.entries : [];
  const openActions = entries.filter(e => ['action','follow_up'].includes(e.kind) && !/done|closed|complete|dropped/i.test(e.status || '')).length;
  const openRisks = entries.filter(e => e.kind === 'risk' && !/done|closed|resolved/i.test(e.status || '')).length;
  const decisions = entries.filter(e => e.kind === 'decision').length;
  return { openActions, openRisks, decisions };
}
function v276ThreadSnippet(thread) {
  const text = String(thread?.ai?.progressSummary || thread?.ai?.executiveMemory || thread?.objective || thread?.description || thread?.desiredOutcome || '').replace(/\s+/g, ' ').trim();
  return text ? (text.length > 210 ? text.slice(0, 207).replace(/\s+\S*$/, '') + '…' : text) : 'No thread objective captured yet. Add a short objective so Ms. Minutes can track this workstream cleanly.';
}
function v276ThreadUpdatedLabel(d) {
  if (!d) return 'No update yet';
  try { return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }); } catch (_) { return String(d); }
}
function v30ThreadFreshness(thread) {
  const d = new Date(thread.updatedAt || thread.createdAt || 0).getTime();
  const ageDays = Number.isFinite(d) && d > 0 ? Math.floor((Date.now() - d) / 86400000) : 999;
  if (ageDays <= 2) return { label:'Fresh', tone:'fresh', hint:'updated recently' };
  if (ageDays <= 7) return { label:'Quiet', tone:'quiet', hint:'no major movement for a few days' };
  if (ageDays <= 21) return { label:'Needs nudge', tone:'nudge', hint:'worth checking' };
  return { label:'Stale', tone:'stale', hint:'no updates in 21+ days' };
}
function v276ThreadViewModel(thread) {
  const meta = v276ThreadStatusMeta(thread.status);
  const counts = v276EntryCounts(thread);
  const entries = Array.isArray(thread.entries) ? thread.entries : [];
  const latestEntry = entries.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0];
  return {
    ...thread,
    statusLabel: meta.label,
    statusTone: meta.tone,
    snippet: v276ThreadSnippet(thread),
    meetingCount: Array.isArray(thread.meetingIds) ? thread.meetingIds.length : 0,
    openActions: counts.openActions,
    openRisks: counts.openRisks,
    decisions: counts.decisions,
    latestEntryTitle: latestEntry ? (latestEntry.title || latestEntry.body || 'Context added') : '',
    updatedLabel: v276ThreadUpdatedLabel(thread.updatedAt || thread.createdAt),
    freshness: v30ThreadFreshness(thread),
  };
}

router.get('/threads', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const query = threadAccessQuery(req);
    if (rx) {
      query.$and = [{ $or: [
        { name: rx },
        { objective: rx },
        { description: rx },
        { clientName: rx },
        { tags: rx },
        { status: rx },
        { ownerEmail: rx },
        { contributorEmails: rx },
        { memberEmails: rx },
      ] }];
    }
    const threads = await MeetingThread.find(query)
      .select({ name:1, objective:1, desiredOutcome:1, description:1, status:1, ownerUserId:1, ownerEmail:1, createdBy:1, contributorEmails:1, viewerEmails:1, memberEmails:1, tags:1, clientName:1, priority:1, meetingIds:1, entries:1, 'ai.progressSummary':1, 'ai.executiveMemory':1, 'ai.healthLabel':1, 'ai.healthScore':1, updatedAt:1, createdAt:1 })
      .sort({ updatedAt:-1, createdAt:-1 })
      .limit(120)
      .lean();
    const me = String(req.user.email || '').toLowerCase().trim();
    threads.forEach(t => { t.entries = (t.entries || []).filter(e => e.visibility !== 'private' || String(e.createdByEmail || '').toLowerCase() === me); });
    const cards = threads.map(v276ThreadViewModel);
    const counts = {
      total: cards.length,
      active: cards.filter(t => t.statusLabel === 'Active').length,
      atRisk: cards.filter(t => t.statusLabel === 'At Risk' || t.statusLabel === 'Blocked').length,
      actions: cards.reduce((sum, t) => sum + (t.openActions || 0), 0),
    };
    return res.render('user/threads_simple', { title: 'Threads', fullBleed: true, user: req.user, org: req.user.org, threads: cards, q, counts });
  } catch (e) { return next(e); }
});

router.get('/threads/search', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const query = threadAccessQuery(req);
    if (q.length >= 3) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$and = [{ $or: [
        { name: rx }, { objective: rx }, { description: rx }, { clientName: rx }, { status: rx },
        { ownerEmail: rx }, { contributorEmails: rx }, { memberEmails: rx }, { tags: rx },
      ] }];
    }
    const threads = await MeetingThread.find(query)
      .select({ _id:1, name:1, objective:1, clientName:1, status:1, ownerEmail:1, meetingIds:1, updatedAt:1 })
      .sort({ updatedAt:-1, createdAt:-1 })
      .limit(q.length >= 3 ? 15 : 8)
      .lean();
    return res.json({ ok: true, threads: threads.map(t => ({
      id: String(t._id),
      name: t.name,
      objective: t.objective || '',
      clientName: t.clientName || '',
      status: t.status || 'Active',
      ownerEmail: t.ownerEmail || '',
      meetingCount: Array.isArray(t.meetingIds) ? t.meetingIds.length : 0,
    })) });
  } catch (e) { return next(e); }
});

router.post('/threads', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect('/user/threads');
    const me = String(req.user.email || '').toLowerCase().trim();
    const requested = uniqEmails(parseCsvEmails(req.body.people || req.body.memberEmails || ''));
    const tenantId = String(req.user.o365?.tid || '').trim();
    const peopleQuery = { org: req.user.org._id, email: { $in: requested }, status: { $ne: 'inactive' } };
    if (tenantId && requested.length) {
      peopleQuery.$and = [{ $or: [
        { 'o365.tid': tenantId },
        { 'o365.tid': { $in: ['', null] } },
        { 'o365.tid': { $exists: false } },
      ] }];
    }
    const registeredPeople = requested.length ? await User.find(peopleQuery).select({ email:1 }).lean() : [];
    const extra = uniqEmails(registeredPeople.map(u => u.email));
    const collaborators = uniqEmails([me, ...extra]);
    const allowed = uniqEmails([me, ...extra, ...(getUserPrincipals(req.user) || [])]);
    const thread = await MeetingThread.create({
      orgId: req.user.org._id,
      name,
      objective: String(req.body.objective || req.body.outcome || '').trim(),
      desiredOutcome: String(req.body.objective || req.body.outcome || '').trim(),
      status: ['Active','At Risk','Blocked','Closed'].includes(req.body.status) ? req.body.status : 'Active',
      ownerUserId: req.user._id,
      ownerEmail: me,
      contributorEmails: collaborators,
      viewerEmails: [],
      memberEmails: collaborators,
      tags: String(req.body.tags || '').split(',').map(x => x.trim()).filter(Boolean),
      clientName: String(req.body.clientName || req.body.clientArea || '').trim(),
      createdBy: req.user._id,
      acl: { allowedEmails: allowed, updatedAt: new Date() },
      entries: [{
        kind: 'status',
        sourceType: 'Manual note',
        visibility: 'thread',
        title: 'Thread created',
        body: `Thread created by ${req.user.name || req.user.email}.`,
        people: collaborators,
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      }],
    });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});

router.get('/threads/:id/meetings/search', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.json({ ok:false, meetings:[] });
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).select({ meetingIds:1 }).lean();
    if (!thread) return res.status(404).json({ ok:false, meetings:[] });
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ ok:true, meetings:[] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const principals = getUserPrincipals(req.user);
    const exclude = (thread.meetingIds || []).map(String);
    const docs = await Transcript.find({
      orgId: req.user.org._id,
      _id: { $nin: exclude },
      'acl.allowedEmails': { $in: principals },
      subject: rx,
      ...v274TranscriptPayloadQuery(),
    }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1 }).sort({ startDateTime:-1, createdAt:-1 }).limit(20).lean();
    return res.json({ ok:true, meetings: docs.map(d => ({ id:String(d._id), subject:d.subject || 'Meeting', startDateTime:d.startDateTime || '', endDateTime:d.endDateTime || '', dateLabel: d.startDateTime ? v276ThreadUpdatedLabel(d.startDateTime) : '' })) });
  } catch (e) { return next(e); }
});

router.post('/threads/:id/link-meetings-simple', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
    if (!thread) return res.status(404).send('Thread not found');
    const ids = String(req.body.meetingIds || '').split(',').map(x => x.trim()).filter(x => mongoose.Types.ObjectId.isValid(x));
    if (!ids.length) return res.redirect('/user/threads/' + req.params.id);
    const principals = getUserPrincipals(req.user);
    const docs = await Transcript.find({ _id: { $in: ids }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, acl:1 }).lean();
    await v278LinkDocsToThread(req, thread, docs, { recurring: !!req.body.addRecurring });
    return res.redirect('/user/threads/' + req.params.id);
  } catch (e) { return next(e); }
});

router.post('/transcript/saved/:id/add-to-thread', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/meetings');
    const threadId = String(req.body.threadId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(threadId)) return res.redirect('/user/transcript/saved/' + req.params.id + '/summary');
    const principals = getUserPrincipals(req.user);
    const doc = await Transcript.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, acl:1 }).lean();
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: threadId });
    if (!doc || !thread) return res.status(404).send('Meeting or thread not found');
    await v278LinkDocsToThread(req, thread, [doc], { recurring: !!req.body.addRecurring });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});


router.post('/threads/:id/collaborators', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const requested = uniqEmails(parseCsvEmails(req.body.people || req.body.memberEmails || ''));
    if (!requested.length) return res.redirect('/user/threads/' + req.params.id);
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
    if (!thread) return res.status(404).send('Thread not found');
    if (!v279CanManageThreadPeople(req, thread)) return res.status(403).send('Only thread collaborators can add collaborators.');

    const tenantId = String(req.user.o365?.tid || '').trim();
    const peopleQuery = {
      org: req.user.org._id,
      email: { $in: requested },
      status: { $ne: 'inactive' },
    };
    if (tenantId) {
      peopleQuery.$and = [{ $or: [
        { 'o365.tid': tenantId },
        { 'o365.tid': { $in: ['', null] } },
        { 'o365.tid': { $exists: false } },
      ] }];
    }
    const registered = await User.find(peopleQuery).select({ email:1, name:1 }).lean();
    const emails = uniqEmails(registered.map(u => u.email));
    const existing = uniqEmails([...(thread.contributorEmails || []), ...(thread.memberEmails || []), thread.ownerEmail]);
    const additions = emails.filter(e => !existing.includes(e));
    if (!additions.length) return res.redirect('/user/threads/' + thread._id);

    const contributorEmails = uniqEmails([...(thread.contributorEmails || []), ...additions]);
    const memberEmails = uniqEmails([...(thread.memberEmails || []), ...contributorEmails, thread.ownerEmail]);
    const aclAllowed = uniqEmails([...(thread.acl?.allowedEmails || []), ...additions, ...(getUserPrincipals(req.user) || []), thread.ownerEmail]);
    await MeetingThread.updateOne({ _id: thread._id }, {
      $set: {
        contributorEmails,
        memberEmails,
        'acl.allowedEmails': aclAllowed,
        'acl.updatedAt': new Date(),
        updatedAt: new Date(),
      },
      $push: { entries: {
        kind: 'status',
        sourceType: 'Manual note',
        visibility: 'thread',
        title: 'Collaborators added',
        body: `${req.user.name || req.user.email} added ${additions.join(', ')} as collaborator${additions.length === 1 ? '' : 's'}.`,
        people: additions,
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      } }
    });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});



async function v29BuildThreadQuickInsight(req, thread, kind) {
  const principals = getUserPrincipals(req.user);
  const meetingIds = (thread.meetingIds || []).filter(Boolean);
  const meetings = meetingIds.length ? await Transcript.find({
    _id: { $in: meetingIds }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals }, startDateTime: { $lte: new Date().toISOString() }
  }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.status':1, 'ai.error':1, 'ai.model':1, 'ai.updatedAt':1, updatedAt:1 })
    .sort({ startDateTime:-1, createdAt:-1 }).limit(8).lean() : [];
  const meetingById = new Map(meetings.map(m => [String(m._id), m]));
  // v29.4: keep thread intelligence focused on substance.
  // System/admin entries such as collaborator changes, thread creation, and auto-link logs
  // are useful for audit/UI, but they should not pollute "Last meeting?" or prep output.
  function isMaterialThreadEntryForAi(e) {
    const kind = String(e?.kind || '').toLowerCase();
    const title = String(e?.title || '').toLowerCase();
    const body = String(e?.body || '').toLowerCase();
    const source = String(e?.sourceType || '').toLowerCase();
    const blob = `${kind} ${title} ${body} ${source}`;
    if (!String(e?.body || '').trim() && !String(e?.title || '').trim()) return false;
    if (kind === 'status') return false;
    if (kind === 'meeting' && /linked\s+\d+\s+meeting|auto-linked|recurring match|imported calendar invite|manual meeting/.test(blob)) return false;
    if (/thread created|thread updated|collaborator added|collaborators added|collaborator removed|added .* collaborator|removed .* from this thread/.test(blob)) return false;
    if (/auto-linked .* recurring meeting|linked .* recurring match|imported calendar invite/.test(blob)) return false;
    return true;
  }
  const sharedEntries = (thread.entries || [])
    .filter(e => e.visibility !== 'private')
    .filter(isMaterialThreadEntryForAi)
    .slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,60);
  function entryLine(e) {
    const related = e.linkedTranscriptId ? meetingById.get(String(e.linkedTranscriptId)) : null;
    const relatedLine = related ? `Related meeting: ${v292MeetingRefLabel(related)}\n` : '';
    const createdLine = e.createdAt ? `Added: ${v276ThreadUpdatedLabel(e.createdAt)}\n` : '';
    return `${String(e.kind || 'note').toUpperCase()}: ${e.title || ''}\n${relatedLine}${createdLine}${v283StripHtml(e.body || '')}${e.status ? `\nStatus: ${e.status}` : ''}`.trim();
  }
  function entryContext(entries = sharedEntries) {
    return entries.map(entryLine).filter(Boolean).join('\n\n---\n\n');
  }
  function entriesAfterMeeting(m) {
    if (!m) return [];
    const mid = String(m._id || '');
    const anchor = Date.parse(m.endDateTime || m.startDateTime || '') || Date.parse(m.startDateTime || '') || 0;
    return sharedEntries.filter(e => {
      const linked = e.linkedTranscriptId && String(e.linkedTranscriptId) === mid;
      const added = Date.parse(e.createdAt || '') || 0;
      return linked || (anchor && added >= anchor);
    }).slice(0, 20);
  }
  function meetingBlock(m, label) {
    const content = m.ai?.summary || (m.text || m.vtt || '').slice(0, 6000);
    return `${label}: ${m.subject || 'Meeting'}\nDate: ${m.startDateTime || ''}\n${content}`;
  }
  const sources = meetings.slice(0, 6).map(m => ({ title: m.subject || 'Meeting', startDateTime: m.startDateTime || '', href: `/user/transcript/saved/${m._id}/summary` }));
  const baseSourcePayload = {
    threadUpdatedAt: thread.updatedAt || '',
    meetingIds: meetings.map(m => [String(m._id), m.startDateTime || '', m.ai?.updatedAt || '', m.updatedAt || '', !!m.ai?.summary]),
    entries: sharedEntries.map(e => [String(e._id || ''), e.kind, e.title || '', String(e.linkedTranscriptId || ''), e.createdAt || '', e.updatedAt || '', v283StripHtml(e.body || '').slice(0, 1200)]),
  };

  if (kind === 'last') {
    const title = 'What did we discuss in the last meeting?';
    if (!meetings.length) return { title:'Last meeting', answer:'No meetings are linked to this thread yet.', model:'deterministic-v29.4', sources:[], sourceHash:v29Hash({ kind, empty:true, promptVersion:'v29.4-last-meeting-asks' }) };
    const latest = meetings[0];
    const updates = entriesAfterMeeting(latest);
    const fresh = latest.ai?.summary ? latest : await v272EnsureSummaryForDoc(latest);
    const sourceHash = v29Hash({ kind, promptVersion:'v29.4-last-meeting-asks', latest: baseSourcePayload.meetingIds[0], updates: updates.map(e => [String(e._id||''), e.kind, e.title, e.createdAt, String(e.linkedTranscriptId||''), v283StripHtml(e.body||'').slice(0, 1200)]), summaryUpdatedAt: fresh.ai?.updatedAt || '' });
    const updateText = updates.length ? entryContext(updates) : 'No material thread updates were added after this meeting.';
    const ctx = `Thread: ${thread.name}\nObjective: ${thread.objective || thread.desiredOutcome || thread.description || ''}\n\n${meetingBlock(fresh, 'Latest linked meeting')}\n\n---\n\nMATERIAL THREAD UPDATES AFTER THIS MEETING\n${updateText}`;
    return {
      title,
      question: `Build a leader-friendly "Last meeting" brief for this thread.

Output exactly these sections:
### Last Meeting Snapshot
- Summarize what actually mattered in the latest linked meeting.

### Updates Added After That Meeting
- Include only material notes/follow-ups/MoMs/progress updates added after the meeting or tied to that meeting. If none, write "No material updates were added after the meeting."

### What to Ask
- Always include 4-6 pointed questions to ask next, grounded in the meeting and the material updates.
- Do not mention collaborators being added/removed, thread creation, auto-linking, imported invites, or other system/admin activity.
- Do not use owner labels or speaker attribution.
- Keep it crisp, practical, and specific.`,
      context: ctx.slice(0, 32000),
      sources: sources.slice(0,1),
      sourceHash,
      needsAi: true,
    };
  }

  let question = '';
  let title = '';
  let ctx = `Thread: ${thread.name}\nObjective: ${thread.objective || thread.desiredOutcome || thread.description || ''}\nStatus: ${thread.status || ''}\n\n`;
  if (kind === 'changed') {
    title = 'What changed since the previous meeting?';
    if (meetings.length < 2) return { title, answer:'Link at least two meetings to compare what changed.', model:'deterministic-v29', sources, sourceHash:v29Hash({ kind, notEnough: meetings.length, entries: baseSourcePayload.entries }) };
    const latest = meetings[0];
    const previous = meetings[1];
    ctx += meetingBlock(previous, 'Previous linked meeting') + '\n\n---\n\n' + meetingBlock(latest, 'Latest linked meeting') + '\n\n---\n\nThread notes and post-meeting updates:\n' + entryContext();
    question = 'Compare the latest linked meeting with the previous linked meeting. Also consider thread updates added after those meetings. Tell me what materially changed, what moved forward, what became a new risk, what remained stuck, and what needs attention next. Use concrete bullets only.';
  } else if (kind === 'actions') {
    title = 'Open follow-ups and actions';
    ctx += meetings.slice(0,4).map((m,i)=>meetingBlock(m, i === 0 ? 'Latest meeting' : `Linked meeting ${i+1}`)).join('\n\n---\n\n') + '\n\n---\n\nThread notes and meeting-linked updates:\n' + entryContext();
    question = 'List open follow-ups visible in this thread, linked meetings, and thread updates added after meetings. Since structured action tracking is not ready, do not pretend this is a complete action register. Separate explicit follow-ups from implied follow-up questions. Do not include owner labels; focus on the work item and due/timing if clear.';
  } else if (kind === 'progress') {
    title = 'Recent progress update';
    ctx += meetings.slice(0,6).map((m,i)=>meetingBlock(m, i === 0 ? 'Latest meeting' : `Recent meeting ${i+1}`)).join('\n\n---\n\n') + '\n\n---\n\nRecent thread notes and meeting-linked updates:\n' + entryContext();
    question = 'Update me on recent progress in this thread using the last 5 to 6 linked meetings and recent thread notes. Give special weight to updates added after meetings. Focus on what moved forward, what newly changed, what is still stuck, what needs leadership attention, and next practical steps.';
  } else {
    title = 'Risks, blockers, and decisions';
    ctx += meetings.slice(0,4).map((m,i)=>meetingBlock(m, i === 0 ? 'Latest meeting' : `Linked meeting ${i+1}`)).join('\n\n---\n\n') + '\n\n---\n\nThread notes and meeting-linked updates:\n' + entryContext();
    question = 'Identify important risks, blockers, unresolved decisions, and dependencies for this thread. Include any risk/progress updates added after linked meetings. Make it useful for a leader preparing for the next discussion.';
  }
  const sourceHash = v29Hash({ kind, source: baseSourcePayload, ctx: ctx.slice(0, 32000) });
  return { title, question, context: ctx.slice(0, 32000), sources, sourceHash, needsAi: true };
}

router.get('/threads/:id/quick-context', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(404).json({ ok:false, error:'Thread not found' });
    const kind = String(req.query.kind || 'last').trim();
    const force = String(req.query.refresh || '') === '1';
    let thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id })
      .select({ name:1, objective:1, desiredOutcome:1, description:1, status:1, meetingIds:1, entries:1, recurringChain:1, updatedAt:1, acl:1 })
      .lean();
    if (!thread) return res.status(404).json({ ok:false, error:'Thread not found' });
    await v29AutoLinkRecurringThread(req, thread, { writeEntry: true });
    thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id })
      .select({ name:1, objective:1, desiredOutcome:1, description:1, status:1, meetingIds:1, entries:1, recurringChain:1, updatedAt:1, acl:1 })
      .lean();

    const preview = await v29BuildThreadQuickInsight(req, thread, kind);
    const allowedEmails = v29CacheAllowedEmails(req, thread.acl?.allowedEmails || []);
    const cached = await IntelligenceCache.findOne({ orgId: req.user.org._id, scopeType:'thread', scopeId: thread._id, kind, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).sort({ generatedAt:-1 }).lean();
    if (cached && !force && cached.sourceHash === preview.sourceHash && cached.answer) {
      return res.json({ ok:true, cacheId:String(cached._id), title: cached.title || preview.title, answer: cached.answer, model: cached.model, sources: cached.sources || [], generatedAt: cached.generatedAt, generatedAtLabel: v29GeneratedLabel(cached.generatedAt), cached: true, sourceHash: cached.sourceHash, review: cached.review || { status:'unreviewed' } });
    }
    let fresh = preview;
    if (preview.needsAi) {
      try {
        const answered = await generateMeetingAnswer({ question: preview.question, context: preview.context, subject: thread.name });
        fresh = { title: preview.title, answer: answered.answer, model: answered.model, sources: preview.sources, sourceHash: preview.sourceHash };
      } catch (e) {
        fresh = { title: preview.title, answer: `Could not run AI just now.

Fallback context:
${String(preview.context || '').slice(0, 3500)}`, model: 'fallback-v29', sources: preview.sources, sourceHash: preview.sourceHash };
      }
    }
    const saved = await IntelligenceCache.findOneAndUpdate(
      { orgId: req.user.org._id, scopeType:'thread', scopeId: thread._id, scopeKey:String(thread._id), kind },
      { $set: { title:fresh.title, answer:fresh.answer, model:fresh.model || '', sources:fresh.sources || [], sourceHash:fresh.sourceHash, generatedAt:new Date(), generatedBy:req.user._id, generatedByEmail:req.user.email, acl:{ allowedEmails, updatedAt:new Date() } }, $inc: { refreshCount: 1 } },
      { upsert:true, new:true }
    ).lean();
    return res.json({ ok:true, cacheId:String(saved._id), title:fresh.title, answer:fresh.answer, model:fresh.model, sources:fresh.sources || [], generatedAt:saved.generatedAt, generatedAtLabel:v29GeneratedLabel(saved.generatedAt), cached:false, sourceHash:fresh.sourceHash, review: saved.review || { status:'unreviewed' } });
  } catch (e) { return next(e); }
});

// v28.5: creator/owner controls for simple threads.
function v285CanManageSimpleThread(req, thread) {
  return canOwnThread(req, thread || {});
}

router.post('/threads/:id/update-simple', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).select({ _id:1, ownerUserId:1, ownerEmail:1 });
    if (!thread) return res.status(404).send('Thread not found');
    if (!v285CanManageSimpleThread(req, thread)) return res.status(403).send('Only the thread creator can edit this thread.');
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect('/user/threads/' + thread._id);
    const status = ['Active','At Risk','Blocked','Closed'].includes(req.body.status) ? req.body.status : 'Active';
    await MeetingThread.updateOne({ _id: thread._id }, {
      $set: {
        name,
        objective: String(req.body.objective || '').trim(),
        desiredOutcome: String(req.body.objective || '').trim(),
        clientName: String(req.body.clientName || '').trim(),
        status,
        updatedAt: new Date(),
      },
      $push: { entries: {
        kind: 'status',
        sourceType: 'Manual note',
        visibility: 'thread',
        title: 'Thread updated',
        body: `${req.user.name || req.user.email} updated the thread details.`,
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      } }
    });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});

router.post('/threads/:id/collaborators/remove', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const email = String(req.body.email || '').toLowerCase().trim();
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).select({ _id:1, ownerUserId:1, ownerEmail:1, contributorEmails:1, viewerEmails:1, memberEmails:1, acl:1 });
    if (!thread) return res.status(404).send('Thread not found');
    if (!v285CanManageSimpleThread(req, thread)) return res.status(403).send('Only the thread creator can remove collaborators.');
    if (!email || email === String(thread.ownerEmail || '').toLowerCase()) return res.redirect('/user/threads/' + thread._id);
    const remove = (arr) => uniqEmails(arr || []).filter(x => String(x || '').toLowerCase() !== email);
    await MeetingThread.updateOne({ _id: thread._id }, {
      $set: {
        contributorEmails: remove(thread.contributorEmails),
        viewerEmails: remove(thread.viewerEmails),
        memberEmails: remove(thread.memberEmails),
        'acl.allowedEmails': remove(thread.acl?.allowedEmails),
        'acl.updatedAt': new Date(),
        updatedAt: new Date(),
      },
      $push: { entries: {
        kind: 'status',
        sourceType: 'Manual note',
        visibility: 'thread',
        title: 'Collaborator removed',
        body: `${req.user.name || req.user.email} removed ${email} from this thread.`,
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      } }
    });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});

router.post('/threads/:id/delete-simple', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).select({ _id:1, ownerUserId:1, ownerEmail:1, deletedAt:1 });
    if (!thread) return res.status(404).send('Thread not found');
    if (!v285CanManageSimpleThread(req, thread)) return res.status(403).send('Only the thread creator can delete this thread.');
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { deletedAt: new Date(), deletedBy: req.user._id, updatedAt: new Date() } });
    return res.redirect('/user/threads');
  } catch (e) { return next(e); }
});

router.post('/threads/:id/auto-link-check', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
    if (!thread) return res.status(404).send('Thread not found');
    if (!canContributeThread(req, thread)) return res.status(403).send('Only collaborators can check recurring links.');
    await v29AutoLinkRecurringThread(req, thread, { writeEntry: true });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});

router.post('/threads/:id/auto-link-off', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
    if (!thread) return res.status(404).send('Thread not found');
    if (!canContributeThread(req, thread)) return res.status(403).send('Only collaborators can change recurring links.');
    await MeetingThread.updateOne({ _id: thread._id }, { $set: { 'recurringChain.enabled': false, 'recurringChain.lastConnectedAt': new Date(), updatedAt: new Date() } });
    return res.redirect('/user/threads/' + thread._id);
  } catch (e) { return next(e); }
});

router.get('/threads/:id', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    let thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id })
      .select({ name:1, objective:1, desiredOutcome:1, description:1, status:1, ownerUserId:1, ownerEmail:1, createdBy:1, contributorEmails:1, viewerEmails:1, memberEmails:1, tags:1, clientName:1, priority:1, meetingIds:1, entries:1, recurringChain:1, 'ai.progressSummary':1, 'ai.executiveMemory':1, 'ai.healthLabel':1, 'ai.healthScore':1, updatedAt:1, createdAt:1 })
      .lean();
    if (!thread) return res.status(404).send('Thread not found');
    const autoLinkResult = await v29AutoLinkRecurringThread(req, thread, { writeEntry: true });
    if (autoLinkResult.checked) {
      thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id })
        .select({ name:1, objective:1, desiredOutcome:1, description:1, status:1, ownerUserId:1, ownerEmail:1, createdBy:1, contributorEmails:1, viewerEmails:1, memberEmails:1, tags:1, clientName:1, priority:1, meetingIds:1, entries:1, recurringChain:1, 'ai.progressSummary':1, 'ai.executiveMemory':1, 'ai.healthLabel':1, 'ai.healthScore':1, updatedAt:1, createdAt:1 })
        .lean();
    }
    const principals = getUserPrincipals(req.user);
    const meetingIds = (thread.meetingIds || []).filter(Boolean);
    const meetings = meetingIds.length ? await Transcript.find({ _id: { $in: meetingIds }, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals }, startDateTime: { $lte: new Date().toISOString() } })
      .select({ _id:1, subject:1, startDateTime:1, endDateTime:1, 'ai.summary':1, 'ai.status':1 })
      .sort({ startDateTime:-1 })
      .limit(80)
      .lean() : [];
    const vm = v276ThreadViewModel(thread);
    const me = String(req.user.email || '').toLowerCase().trim();
    const meetingLabelById = new Map((meetings || []).map(m => [String(m._id), v292MeetingRefLabel(m)]));
    function isUsefulVisibleThreadContext(e) {
      const kind = String(e?.kind || '').toLowerCase();
      const title = String(e?.title || '').toLowerCase();
      const body = String(e?.body || '').toLowerCase();
      const source = String(e?.sourceType || '').toLowerCase();
      const blob = `${kind} ${title} ${body} ${source}`;
      if (kind === 'status') return false;
      if (kind === 'meeting' && /linked\s+\d+\s+meeting|auto-linked|recurring match|imported calendar invite|manual meeting/.test(blob)) return false;
      if (/thread created|thread updated|collaborator added|collaborators added|collaborator removed|added .* collaborator|removed .* from this thread|auto-linked .* recurring meeting/.test(blob)) return false;
      return true;
    }
    let entries = (thread.entries || [])
      .filter(e => e.visibility !== 'private' || String(e.createdByEmail || '').toLowerCase() === me)
      .filter(isUsefulVisibleThreadContext)
      .slice()
      .sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))
      .slice(0,80)
      .map(e => ({ ...e, canEditEntry: String(e.createdByEmail || '').toLowerCase() === me || String(e.createdBy || '') === String(req.user._id), linkedMeetingLabel: e.linkedTranscriptId ? meetingLabelById.get(String(e.linkedTranscriptId)) : '' }));
    if (entries.length < 10 && meetings && meetings.length) {
      const existingMeetingEntryIds = new Set(entries.map(e => String(e.linkedTranscriptId || '')).filter(Boolean));
      const supplemental = meetings
        .filter(m => !existingMeetingEntryIds.has(String(m._id)) && (m.ai?.summary || m.ai?.detailedNotes))
        .slice(0, 10 - entries.length)
        .map(m => ({
          _id: 'meeting-' + String(m._id),
          kind: 'meeting',
          sourceType: 'Teams meeting',
          visibility: 'thread',
          title: m.subject || 'Linked meeting context',
          body: v31Clip(m.ai?.summary || m.ai?.detailedNotes || '', 900),
          linkedTranscriptId: m._id,
          linkedMeetingLabel: v292MeetingRefLabel(m),
          createdAt: m.startDateTime || new Date(0),
          canEditEntry: false,
          synthetic: true,
        }));
      entries = entries.concat(supplemental).slice(0, 10);
    }
    return res.render('user/thread_detail_simple', { title: thread.name, fullBleed: true, activeNav: 'threads', user: req.user, org: req.user.org, thread: vm, meetings, entries, fmtTime: v276ThreadUpdatedLabel, canManageThread: v285CanManageSimpleThread(req, thread), autoLinkResult, issueSubmitted: String(req.query.issue || '') === '1' });
  } catch (e) { return next(e); }
});

router.post('/threads/:id/notes', requireUser, meetingFileUpload.array('files', 8), async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.redirect('/user/threads');
    const body = v281SanitizeRichThreadNote(req.body.body || '');
    if (!body) return res.redirect('/user/threads/' + req.params.id);
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).select({ _id:1, ownerUserId:1, ownerEmail:1, createdBy:1, contributorEmails:1, viewerEmails:1, memberEmails:1, acl:1, meetingIds:1 });
    if (!thread) return res.status(404).send('Thread not found');
    if (!canContributeThread(req, thread)) return res.status(403).send('Only thread collaborators can add notes.');
    const typeMeta = v279EntryType(req.body.kind || req.body.noteType, req.body.visibility);
    const kind = typeMeta.kind;
    const visibility = typeMeta.visibility;
    const title = String(req.body.title || typeMeta.title || '').trim();
    const rawLinked = String(req.body.linkedTranscriptId || '').trim();
    let linkedTranscriptId = null;
    if (mongoose.Types.ObjectId.isValid(rawLinked)) {
      const allowedMeetingIds = new Set((thread.meetingIds || []).map(String));
      if (allowedMeetingIds.has(rawLinked)) linkedTranscriptId = new mongoose.Types.ObjectId(rawLinked);
    }
    await MeetingThread.updateOne({ _id: thread._id }, {
      $push: { entries: {
        kind,
        sourceType: visibility === 'private' ? 'Manual note' : sourceForKind(kind),
        visibility,
        title,
        body,
        linkedTranscriptId,
        ownerEmail: String(req.body.ownerEmail || '').toLowerCase().trim(),
        status: String(req.body.status || '').trim(),
        severity: ['Low','Medium','High','Critical'].includes(req.body.severity) ? req.body.severity : '',
        files: briefingFilesFromUpload(req.files || []).map(f => ({ ...f, uploadedByEmail: req.user.email })),
        createdBy: req.user._id,
        createdByEmail: req.user.email,
        createdAt: new Date(),
      } },
      $set: { updatedAt: new Date() }
    });
    return res.redirect('/user/threads/' + req.params.id);
  } catch (e) { return next(e); }
});

router.post('/threads/:id/notes/:entryId/update', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || '')) || !mongoose.Types.ObjectId.isValid(String(req.params.entryId || ''))) return res.redirect('/user/threads');
    const me = String(req.user.email || '').toLowerCase().trim();
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id:req.params.id, 'entries._id': req.params.entryId }).select({ _id:1, entries:1 });
    if (!thread) return res.status(404).send('Thread note not found');
    const entry = (thread.entries || []).find(e => String(e._id) === String(req.params.entryId));
    if (!entry || (String(entry.createdByEmail || '').toLowerCase() !== me && String(entry.createdBy || '') !== String(req.user._id))) return res.status(403).send('You can edit only notes you created.');
    const body = v281SanitizeRichThreadNote(req.body.body || '');
    if (!body) return res.redirect('/user/threads/' + req.params.id);
    await MeetingThread.updateOne(
      { _id: thread._id, 'entries._id': req.params.entryId },
      { $set: {
        'entries.$.title': String(req.body.title || '').trim(),
        'entries.$.body': body,
        'entries.$.status': String(req.body.status || '').trim(),
        'entries.$.severity': ['Low','Medium','High','Critical'].includes(req.body.severity) ? req.body.severity : '',
        updatedAt: new Date(),
      } }
    );
    await writeAudit(req, 'THREAD_NOTE_UPDATED', 'MeetingThread', thread._id, 'Updated own thread note', { entryId:req.params.entryId });
    return res.redirect('/user/threads/' + req.params.id);
  } catch(e) { return next(e); }
});

router.post('/threads/:id/notes/:entryId/delete', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || '')) || !mongoose.Types.ObjectId.isValid(String(req.params.entryId || ''))) return res.redirect('/user/threads');
    const me = String(req.user.email || '').toLowerCase().trim();
    const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id:req.params.id, 'entries._id': req.params.entryId }).select({ _id:1, entries:1 });
    if (!thread) return res.status(404).send('Thread note not found');
    const entry = (thread.entries || []).find(e => String(e._id) === String(req.params.entryId));
    if (!entry || (String(entry.createdByEmail || '').toLowerCase() !== me && String(entry.createdBy || '') !== String(req.user._id))) return res.status(403).send('You can delete only notes you created.');
    await MeetingThread.updateOne({ _id: thread._id }, { $pull: { entries: { _id: req.params.entryId } }, $set: { updatedAt: new Date() } });
    await writeAudit(req, 'THREAD_NOTE_DELETED', 'MeetingThread', thread._id, 'Deleted own thread note', { entryId:req.params.entryId });
    return res.redirect('/user/threads/' + req.params.id);
  } catch(e) { return next(e); }
});


// v27.8: typeahead must sit before /people/:email redirect, otherwise "search" is swallowed as :email.
router.get('/people/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ ok: true, people: [] });
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const tenantId = String(req.user.o365?.tid || '').trim();
  const query = {
    org: req.user.org._id,
    status: { $ne: 'inactive' },
    $or: [{ name: rx }, { email: rx }, { 'principals.emails': rx }],
  };
  if (tenantId) {
    query.$and = [{ $or: [
      { 'o365.tid': tenantId },
      { 'o365.tid': { $in: ['', null] } },
      { 'o365.tid': { $exists: false } },
    ] }];
  }
  const users = await User.find(query)
    .select({ name:1, email:1, 'o365.tid':1 })
    .sort({ name:1, email:1 })
    .limit(20)
    .lean();
  const me = String(req.user.email || '').toLowerCase().trim();
  const people = users
    .filter(u => String(u.email || '').toLowerCase() !== me)
    .map(u => ({ name: u.name || u.email, email: u.email }));
  return res.json({ ok: true, people });
});



// v29: reliability helpers for caching intelligence, recurring thread auto-linking, and calendar imports.
function v29Hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value || {})).digest('hex');
}
function v29GeneratedLabel(value) {
  return value ? v276ThreadUpdatedLabel(value) : '';
}
function v29CacheAllowedEmails(req, extras = []) {
  return uniqEmails([...(getUserPrincipals(req.user) || []), String(req.user.email || '').toLowerCase().trim(), ...extras]);
}
function v29MeetingScopeKey(ev) {
  const ical = String(ev.iCalUId || ev.icalUId || ev.icalUid || '').trim();
  const series = String(ev.seriesMasterId || ev.recurringSeriesMasterId || '').trim();
  if (ical) return `ical:${ical}`;
  if (series) return `series:${series}:${v283MeetingSubjectKey(ev.subject || '')}`;
  return `event:${String(ev.eventId || ev.id || '') || v29Hash([ev.subject, ev.startDateTime, ev.endDateTime].join('|')).slice(0, 24)}`;
}

function v31Bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['true','yes','1','on','y'].includes(String(v).trim().toLowerCase());
}
function v31AssistantPermissionsFromBody(body = {}) {
  return {
    canAddGeneralNotes: v31Bool(body.canAddGeneralNotes, true),
    canAddMeetingNotes: v31Bool(body.canAddMeetingNotes, true),
    canAddThreadNotes: v31Bool(body.canAddThreadNotes, true),
    canAddQuestions: v31Bool(body.canAddQuestions, true),
    canAddFollowups: v31Bool(body.canAddFollowups, true),
    canAddRisks: v31Bool(body.canAddRisks, true),
    canSeeOwnNotes: true,
  };
}
function v31PrincipalAcl(user, extras = []) {
  return uniqEmails([...(getUserPrincipals(user) || []), user?.email, ...extras]);
}
function v31RelationLabel(v) {
  return ({ precursor_to:'Precursor to', followup_to:'Follow-up to', continues:'Continues discussion from', provides_context_for:'Provides context for', resulted_from:'Resulted from', related_to:'Related to' })[String(v || '')] || 'Related to';
}
function v31NoteTypeLabel(v) {
  return ({ question:'Question to ask', prep:'Prep note', followup:'Follow-up reminder', risk:'Risk / watchout', decision:'Decision needed', general:'General note', thread_note:'Thread note', meeting_note:'Meeting note' })[String(v || '')] || 'General note';
}
function v31SearchRegex(value) {
  const q = String(value || '').trim();
  if (!q) return null;
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}
function v31TopicTerms(topic) {
  const stop = new Set(['about','what','did','discuss','discussion','meeting','meetings','with','from','this','that','have','were','was','are','for','the','and','our','your']);
  const base = String(topic || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !stop.has(x));
  const t = String(topic || '').toLowerCase();
  const extra = [];
  if (/pricing|price|commercial|billing|charge|fee|rate/.test(t)) extra.push('pricing','price','commercial','billing','charge','fee','rate card','license','managed services','revenue share','transfer model','margin','commercial model');
  if (/transaction/.test(t)) extra.push('transaction','transaction pricing','usage pricing','volume','per transaction','txn');
  if (/roadmap|platform|product|studio/.test(t)) extra.push('roadmap','platform roadmap','product roadmap','platform direction','studio','platform capability','release plan','ga plan');
  if (/customer|client/.test(t)) extra.push('customer','client','account','customer health','go back to green');
  if (/ai|artificial|automation/.test(t)) extra.push('ai','artificial intelligence','automation','agent','llm','copilot');
  return [...new Set([String(topic || '').trim(), ...base, ...extra].filter(Boolean))].slice(0, 24);
}
function v31TextMatchesTerms(text, terms) {
  const profile = v311TopicProfile((terms && terms[0]) || '');
  if (terms && terms.length) profile.terms = terms;
  return v311Relevance(text, profile).ok;
}
function v31Clip(text, max = 900) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : (t.slice(0, max).replace(/\s+\S*$/, '') + '…');
}
function v311TopicProfile(topic) {
  const raw = String(topic || '').trim();
  const stop = new Set(['about','what','did','discuss','discussion','meeting','meetings','with','from','this','that','have','were','was','are','for','the','and','our','your']);
  const base = raw.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 3 && !stop.has(x));
  const terms = v31TopicTerms(raw);
  return { raw, phrase: raw.toLowerCase(), base, terms };
}
function v311CountTerm(hay, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return 0;
  const idx = hay.indexOf(t);
  if (idx < 0) return 0;
  return hay.split(t).length - 1;
}
function v311Relevance(text, profile) {
  const hay = String(text || '').toLowerCase();
  const phrase = String(profile?.phrase || '').trim();
  const base = Array.isArray(profile?.base) ? profile.base : [];
  const terms = Array.isArray(profile?.terms) ? profile.terms : [];
  const exact = phrase && phrase.length >= 3 ? v311CountTerm(hay, phrase) : 0;
  const baseHits = base.filter(t => v311CountTerm(hay, t) > 0);
  const extraHits = terms.filter(t => !base.includes(String(t).toLowerCase()) && String(t).toLowerCase() !== phrase && v311CountTerm(hay, t) > 0);
  let score = exact * 8 + baseHits.length * 3 + Math.min(extraHits.length, 5);
  if (base.length > 1 && baseHits.length === base.length) score += 3;
  const ok = exact > 0 || (base.length > 1 && baseHits.length === base.length) || (base.length <= 1 && baseHits.length > 0) || score >= 8;
  return { ok, score, exact, baseHits, extraHits };
}
function v311RelevantClip(text, profile, max = 1000) {
  const raw = String(text || '').replace(/\r/g, '\n');
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const sentences = compact.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(Boolean).slice(0, 260);
  const scored = sentences.map((sentence, i) => ({ sentence, i, rel: v311Relevance(sentence, profile) }))
    .filter(x => x.rel.ok || x.rel.score > 0)
    .sort((a,b) => (b.rel.score - a.rel.score) || (a.i - b.i));
  let picked = scored.slice(0, 5).sort((a,b) => a.i - b.i).map(x => x.sentence).join(' ');
  if (!picked) picked = compact;
  return v31Clip(picked, max);
}

function v312InputDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}
function v312ApplyQuickRange(range) {
  const days = ({ '3d': 3, '7d': 7, '15d': 15, '30d': 30 })[String(range || '')];
  if (!days) return null;
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from: v312InputDate(start), to: v312InputDate(end), label: `Last ${days} days` };
}
async function v312RecallMeetingOptions(req, limit = 90) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const docs = await Transcript.find({ orgId, 'acl.allowedEmails': { $in: principals }, ...v274TranscriptPayloadQuery() })
    .select({ _id: 1, subject: 1, startDateTime: 1, eventId: 1 })
    .sort({ startDateTime: -1 })
    .limit(limit)
    .lean();
  return docs.map(d => ({
    id: String(d._id),
    eventId: d.eventId || '',
    title: d.subject || 'Untitled meeting',
    date: d.startDateTime || '',
    label: `${d.startDateTime ? new Date(d.startDateTime).toLocaleDateString('en-IN') + ' · ' : ''}${d.subject || 'Untitled meeting'}`,
  }));
}

async function v31AccessibleAssistantNotes(req, { eventId = '', threadIds = [], since = null, until = null, limit = 20 } = {}) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user).map(x => String(x || '').toLowerCase());
  const q = { orgId, $or: [{ principalEmail: { $in: principals } }, { assistantEmail: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }] };
  if (eventId) q.$or.push({ eventId: String(eventId) });
  if (threadIds && threadIds.length) q.threadId = { $in: threadIds.filter(id => mongoose.Types.ObjectId.isValid(String(id))).map(id => new mongoose.Types.ObjectId(String(id))) };
  if (since || until) {
    q.createdAt = {};
    if (since) q.createdAt.$gte = since;
    if (until) q.createdAt.$lte = until;
  }
  return AssistantNote.find(q).sort({ createdAt:-1 }).limit(limit).lean();
}
function v31AssistantNotesText(notes = []) {
  return (notes || []).map((n, i) => {
    const target = n.targetTitle ? `Target: ${n.targetTitle}` : (n.targetType ? `Target: ${n.targetType}` : '');
    return `${i+1}. ${v31NoteTypeLabel(n.noteType)}${n.title ? ' — ' + n.title : ''}\n${target}\nFrom assistant: ${n.assistantName || n.assistantEmail}\nFor: ${n.principalName || n.principalEmail}\n${n.body || ''}`;
  }).join('\n\n---\n\n');
}
function v313EventKeys(ev = {}) {
  const eventId = String(ev.eventId || ev.id || '').trim();
  const ical = String(ev.iCalUId || ev.icalUId || ev.icalUid || '').trim();
  return { eventId, ical };
}
function v313MeetingPeople(ev = {}) {
  return uniqEmails([ev.userEmail, ev.organizerEmail, ...(ev.attendeeEmails || [])]);
}
function v313MeetingLinkAcl(req, fromEv = {}, toEv = {}) {
  return uniqEmails([...(getUserPrincipals(req.user) || []), req.user.email, ...v313MeetingPeople(fromEv), ...v313MeetingPeople(toEv)]);
}
function v313LinkTouchesEvent(link = {}, eventId = '', ical = '') {
  return (eventId && (link.fromEventId === eventId || link.toEventId === eventId)) || (ical && (link.fromICalUId === ical || link.toICalUId === ical));
}
function v313OtherEventKeys(link = {}, eventId = '', ical = '') {
  const out = [];
  if ((eventId && link.fromEventId === eventId) || (ical && link.fromICalUId === ical)) out.push({ eventId: link.toEventId || '', ical: link.toICalUId || '' });
  if ((eventId && link.toEventId === eventId) || (ical && link.toICalUId === ical)) out.push({ eventId: link.fromEventId || '', ical: link.fromICalUId || '' });
  return out.filter(k => k.eventId || k.ical);
}
async function v31FindManualMeetingLinkedDocs(req, ev, limit = 6) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user).map(x => String(x || '').toLowerCase());
  const startKeys = v313EventKeys(ev);
  if (!startKeys.eventId && !startKeys.ical) return { links: [], docs: [], network: [] };

  const allLinks = await MeetingLink.find({ orgId, active:true, 'acl.allowedEmails': { $in: principals } })
    .sort({ createdAt:-1 })
    .limit(260)
    .lean();

  const visited = new Set();
  const queue = [{ ...startKeys, depth: 0, via: [] }];
  const touched = [];
  const eventIds = new Set();
  const iCals = new Set();
  const docIds = new Set();
  if (startKeys.eventId) eventIds.add(startKeys.eventId);
  if (startKeys.ical) iCals.add(startKeys.ical);
  const maxDepth = 3;

  while (queue.length) {
    const node = queue.shift();
    const key = `${node.eventId || ''}|${node.ical || ''}`;
    if (visited.has(key) || node.depth > maxDepth) continue;
    visited.add(key);
    for (const link of allLinks) {
      if (!v313LinkTouchesEvent(link, node.eventId, node.ical)) continue;
      if (!touched.some(x => String(x._id) === String(link._id))) touched.push({ ...link, networkDepth: node.depth, viaPath: node.via || [] });
      if (link.fromEventId) eventIds.add(link.fromEventId);
      if (link.toEventId) eventIds.add(link.toEventId);
      if (link.fromICalUId) iCals.add(link.fromICalUId);
      if (link.toICalUId) iCals.add(link.toICalUId);
      if (link.fromTranscriptDocId) docIds.add(String(link.fromTranscriptDocId));
      if (link.toTranscriptDocId) docIds.add(String(link.toTranscriptDocId));
      if (node.depth < maxDepth) {
        for (const next of v313OtherEventKeys(link, node.eventId, node.ical)) {
          const nkey = `${next.eventId || ''}|${next.ical || ''}`;
          if (!visited.has(nkey)) queue.push({ ...next, depth: node.depth + 1, via: [...(node.via || []), link] });
        }
      }
    }
  }

  eventIds.delete(startKeys.eventId);
  iCals.delete(startKeys.ical);
  if (iCals.size) {
    try {
      const myMatchingEvents = await EventCache.find({ orgId, userEmail:String(req.user.email || '').toLowerCase().trim(), iCalUId:{ $in:[...iCals] } }).select({ eventId:1 }).lean();
      for (const e of myMatchingEvents || []) if (e.eventId) eventIds.add(e.eventId);
    } catch(e) {}
  }
  const or = [];
  if (eventIds.size) or.push({ eventId: { $in: [...eventIds] } });
  const validDocIds = [...docIds].filter(id => mongoose.Types.ObjectId.isValid(id));
  if (validDocIds.length) or.push({ _id: { $in: validDocIds } });
  const docs = or.length ? await Transcript.find({ orgId, 'acl.allowedEmails': { $in: principals }, $or: or, ...v274TranscriptPayloadQuery() })
    .select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .sort({ startDateTime:-1 })
    .limit(limit)
    .lean() : [];
  return { links: touched.slice(0, 50), docs, network: [...eventIds].slice(0, 80) };
}
function v29IcsUnfold(raw) {
  return String(raw || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}
function v29IcsValue(lines, name) {
  const rx = new RegExp('^' + name + '(?:;[^:]*)?:(.*)$', 'i');
  const line = (lines || []).find(l => rx.test(l));
  if (!line) return '';
  const m = line.match(rx);
  return String(m?.[1] || '').replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
}
function v29IcsDate(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^\d{8}T\d{6}Z$/i.test(v)) {
    return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(9,11)}:${v.slice(11,13)}:${v.slice(13,15)}.000Z`;
  }
  if (/^\d{8}T\d{6}$/i.test(v)) {
    return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(9,11)}:${v.slice(11,13)}:${v.slice(13,15)}.000`;
  }
  if (/^\d{8}$/.test(v)) return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T00:00:00.000`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function v29ParseIcs(raw) {
  const text = v29IcsUnfold(raw);
  const eventMatch = text.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i);
  const body = eventMatch ? eventMatch[1] : text;
  const lines = body.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const uid = v29IcsValue(lines, 'UID') || v29Hash(text).slice(0, 24);
  const subject = v29IcsValue(lines, 'SUMMARY') || 'Imported calendar invite';
  const startDateTime = v29IcsDate(v29IcsValue(lines, 'DTSTART'));
  const endDateTime = v29IcsDate(v29IcsValue(lines, 'DTEND')) || startDateTime;
  const location = v29IcsValue(lines, 'LOCATION');
  const description = v29IcsValue(lines, 'DESCRIPTION');
  return { uid, subject, startDateTime, endDateTime, location, description };
}
async function v29AutoLinkRecurringThread(req, thread, { writeEntry = true } = {}) {
  if (!thread || !thread.recurringChain?.enabled) return { checked: false, added: 0 };
  const key = String(thread.recurringChain?.subjectKey || '').trim() || v283MeetingSubjectKey(thread.name || '');
  if (!key || key.length < 3) return { checked: false, added: 0 };
  const principals = getUserPrincipals(req.user);
  const existing = new Set((thread.meetingIds || []).map(String));
  const since = new Date();
  since.setDate(since.getDate() - 540);
  const docs = await Transcript.find({
    orgId: req.user.org._id,
    'acl.allowedEmails': { $in: principals },
    startDateTime: { $gte: since.toISOString(), $lte: new Date().toISOString() },
    ...v274TranscriptPayloadQuery(),
  }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, acl:1 }).sort({ startDateTime:-1 }).limit(900).lean();
  const additions = [];
  for (const d of docs) {
    if (existing.has(String(d._id))) continue;
    const dk = v283MeetingSubjectKey(d.subject || '');
    if (v283RelatedKey(key, dk) || v283RelatedKey(thread.recurringChain?.subjectKey || '', d.subject || '')) additions.push(d);
    if (additions.length >= 40) break;
  }
  const setPayload = {
    'recurringChain.lastConnectedAt': new Date(),
    'recurringChain.subjectKey': key,
    'recurringChain.matchMode': 'subject',
    'recurringChain.enabled': true,
    'recurringChain.connectedCount': existing.size + additions.length,
    'acl.updatedAt': new Date(),
    updatedAt: additions.length ? new Date() : (thread.updatedAt || new Date()),
  };
  if (!additions.length) {
    await MeetingThread.updateOne({ _id: thread._id }, { $set: setPayload });
    return { checked: true, added: 0 };
  }
  const aclExtra = uniqEmails(additions.flatMap(d => d.acl?.allowedEmails || []));
  const update = {
    $addToSet: { meetingIds: { $each: additions.map(d => d._id) }, 'acl.allowedEmails': { $each: aclExtra } },
    $set: setPayload,
  };
  if (writeEntry) {
    update.$push = { entries: {
      kind: 'meeting', sourceType: 'Teams meeting', visibility: 'thread',
      title: `Auto-linked ${additions.length} recurring meeting(s)`,
      body: additions.slice(0, 8).map(d => d.subject || 'Meeting').join('; ') + (additions.length > 8 ? `; and ${additions.length - 8} more` : ''),
      createdBy: req.user._id, createdByEmail: req.user.email, createdAt: new Date(),
    } };
  }
  await MeetingThread.updateOne({ _id: thread._id }, update);
  await EventCache.updateMany({ orgId: req.user.org._id, eventId: { $in: additions.map(d => d.eventId).filter(Boolean) } }, { $set: { linkedThreadId: thread._id, linkedThreadName: thread.name || '' } });
  return { checked: true, added: additions.length };
}

// v28.3 Intelligence: practical meeting-prep cockpit, not a generic chatbot.
function v283StripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
function v283MeetingSubjectKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(cancelled|canceled|updated|rescheduled|fw|fwd|re)\b/g, ' ')
    .replace(/\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/g, ' ')
    .replace(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/g, ' ')
    .replace(/\b(20\d{2}|\d{1,2}(st|nd|rd|th)?|\d{1,2}[:.]\d{2}\s*(am|pm)?)\b/g, ' ')
    .replace(/\b(weekly|daily|monthly|fortnightly|biweekly|recurring|sync|meeting|call|standup|catchup|discussion|session)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function v283TokenOverlap(a, b) {
  const ax = v283MeetingSubjectKey(a).split(/\s+/).filter(x => x.length >= 3);
  const bx = v283MeetingSubjectKey(b).split(/\s+/).filter(x => x.length >= 3);
  if (!ax.length || !bx.length) return 0;
  const bs = new Set(bx);
  const hits = ax.filter(x => bs.has(x)).length;
  return hits / Math.max(1, Math.min(ax.length, bx.length));
}
function v283RelatedKey(a, b) {
  const ak = v283MeetingSubjectKey(a);
  const bk = v283MeetingSubjectKey(b);
  if (!ak || !bk) return false;
  if (ak === bk) return true;
  if (ak.length >= 8 && bk.length >= 8 && (ak.includes(bk) || bk.includes(ak))) return true;
  return v283TokenOverlap(ak, bk) >= 0.72;
}
function v283EventLabels(ev) {
  const labels = v27MeetingLabels(ev.startDateTime, ev.endDateTime);
  const s = v27Date(ev.startDateTime);
  const e = v27Date(ev.endDateTime);
  const duration = s && e && e > s ? Math.max(1, Math.round((e - s) / 60000)) : null;
  return { ...labels, durationMinutes: duration };
}
function v283EvidenceText(doc, max = 3600) {
  const summary = doc?.ai?.summary || doc?.ai?.detailedNotes || '';
  const transcript = doc?.text || (doc?.vtt ? vttToText(doc.vtt) : '');
  const raw = summary || transcript || '';
  return shortPrepText(v283StripHtml(raw), max);
}
function v292MeetingRefLabel(meeting) {
  if (!meeting) return '';
  const when = meeting.startDateTime ? v276ThreadUpdatedLabel(meeting.startDateTime) : '';
  return `${meeting.subject || 'Meeting'}${when ? ' — ' + when : ''}`;
}
function v283ThreadNoteText(entries, me, maxEntries = 8, meetingById = new Map()) {
  return (entries || [])
    .filter(e => e && (e.visibility !== 'private' || String(e.createdByEmail || '').toLowerCase() === me))
    .slice()
    .sort((a,b)=>new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, maxEntries)
    .map(e => {
      const label = e.visibility === 'private' ? 'Personal note' : ({ follow_up:'Follow-up', discussion:'Discussion', moms:'MoMs', progress:'Progress', risk:'Risk', decision:'Decision', status:'Status', meeting:'Meeting update' }[e.kind] || 'Note');
      const related = e.linkedTranscriptId ? meetingById.get(String(e.linkedTranscriptId)) : null;
      const relatedLine = related ? `Related meeting: ${v292MeetingRefLabel(related)}\n` : '';
      const createdLine = e.createdAt ? `Added: ${v276ThreadUpdatedLabel(e.createdAt)}\n` : '';
      return `${label}: ${e.title || ''}\n${relatedLine}${createdLine}${v283StripHtml(e.body || '')}${e.status ? `\nStatus: ${e.status}` : ''}`.trim();
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

async function v283RefreshUpcomingMeetingCache(req, res, rangeStart, rangeEnd) {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();
  if (!accessToken) throw new Error('No Microsoft access token available. Please sign in again, then refresh.');
  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const list = await v292WithTimeout(getCalendarRange(accessToken, {
    startDateTime: rangeStart.toISOString(),
    endDateTime: rangeEnd.toISOString(),
    top: 75,
    max: 220,
  }), 16000, 'Outlook upcoming refresh');
  const events = (Array.isArray(list) ? list : []).filter(ev => ev && !ev.isCancelled && String(ev.subject || '').trim());
  if (!events.length) return 0;
  const bulk = EventCache.collection.initializeUnorderedBulkOp();
  let ops = 0;
  for (const ev of events) {
    const payload = await buildCachePayloadFast(orgId, me, ev);
    if (!payload?.eventId || !payload?.startDateTime) continue;
    bulk.find({ orgId, userEmail: me, eventId: payload.eventId }).upsert().updateOne({
      $set: { ...payload, syncedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    });
    ops++;
  }
  if (ops > 0) await bulk.execute();
  return ops;
}

function v285EndOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function v285IntelligenceFocusRange(now = new Date()) {
  const start = new Date(now);
  const day = start.getDay();
  const daysAhead = day === 5 ? 3 : 1; // Friday: show till Monday; otherwise today + tomorrow.
  const end = v285EndOfDay(addDays(start, daysAhead));
  const label = day === 5 ? 'Today to Monday' : 'Today + tomorrow';
  return { start, end, daysAhead, label };
}
async function v285UpcomingMeetingsBetween(req, rangeStart, rangeEnd, limit = 30) {
  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();
  const nowMs = Date.now();
  const raw = await EventCache.find({
    orgId,
    userEmail: me,
    startDateTime: { $gte: rangeStart.toISOString(), $lte: rangeEnd.toISOString() },
  }).sort({ startDateTime: 1 }).limit(limit).lean();
  return raw.map(ev => {
    const labels = v283EventLabels(ev);
    const subjectKey = v283MeetingSubjectKey(ev.subject || '');
    const endMs = Date.parse(ev.endDateTime || ev.startDateTime || '');
    const isFinished = Number.isFinite(endMs) && endMs <= nowMs;
    return {
      _id: String(ev._id || ''),
      eventId: ev.eventId || '',
      subject: ev.subject || 'Untitled meeting',
      startDateTime: ev.startDateTime || '',
      endDateTime: ev.endDateTime || '',
      location: ev.location || '',
      linkedThreadId: ev.linkedThreadId ? String(ev.linkedThreadId) : '',
      linkedThreadName: ev.linkedThreadName || '',
      hasTranscript: !!ev.hasTranscript && isFinished,
      subjectKey,
      ...labels,
    };
  });
}
async function v283UpcomingMeetings(req, days = 3, limit = 30) {
  const now = new Date();
  return v285UpcomingMeetingsBetween(req, now, addDays(now, days), limit);
}
async function v283FindPrepHistory(req, ev, { docLimit = 3, noteLimit = 8 } = {}) {
  const orgId = req.user.org._id;
  const principals = getUserPrincipals(req.user);
  const me = String(req.user.email || '').toLowerCase().trim();
  const eventStartIso = ev.startDateTime || new Date().toISOString();
  const subject = ev.subject || '';
  const key = v283MeetingSubjectKey(subject);
  const threadMap = new Map();
  const exactThreadId = String(ev.linkedThreadId || '').trim();
  if (mongoose.Types.ObjectId.isValid(exactThreadId)) {
    const t = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: exactThreadId })
      .select({ name:1, meetingIds:1, entries:1, recurringChain:1, status:1, objective:1, desiredOutcome:1, clientName:1 })
      .lean();
    if (t) threadMap.set(String(t._id), { thread: t, basis: 'linked thread' });
  }
  if (key && key.length >= 3) {
    const threads = await MeetingThread.find(threadAccessQuery(req))
      .select({ name:1, meetingIds:1, entries:1, recurringChain:1, status:1, objective:1, desiredOutcome:1, clientName:1 })
      .sort({ updatedAt:-1 })
      .limit(160)
      .lean();
    for (const t of threads) {
      if (threadMap.has(String(t._id))) continue;
      const chainKey = v283MeetingSubjectKey(t.recurringChain?.subjectKey || '');
      const threadNameKey = v283MeetingSubjectKey(t.name || '');
      if ((chainKey && v283RelatedKey(chainKey, key)) || (threadNameKey && v283RelatedKey(threadNameKey, key))) {
        threadMap.set(String(t._id), { thread: t, basis: chainKey ? 'thread recurring key' : 'thread title' });
      }
    }
  }

  const docsById = new Map();
  let matchBasis = '';
  const threadNotes = [];

  // v31: manual meeting links are trusted human context, so use them before title matching.
  try {
    const linked = await v31FindManualMeetingLinkedDocs(req, ev, Math.max(6, docLimit * 3));
    for (const d of linked.docs || []) docsById.set(String(d._id), { doc: d, basis: 'manual meeting link' });
    if (!matchBasis && linked.docs && linked.docs.length) matchBasis = 'manual meeting link';
    if (linked.links && linked.links.length) {
      threadNotes.push('MANUAL MEETING LINKS\n' + linked.links.slice(0, 8).map((l, i) => `${i+1}. ${l.fromSubject || l.fromEventId} ${v31RelationLabel(l.relation)} ${l.toSubject || l.toEventId}${l.reason ? ' — ' + l.reason : ''}`).join('\n'));
    }
  } catch (e) { console.warn('[v31 manual links]', e.message || e); }

  // v31: assistant inputs for the principal are part of preparation context, without exposing private transcripts to assistants.
  try {
    const assistantNotes = await v31AccessibleAssistantNotes(req, { eventId: ev.eventId || '', limit: 12 });
    const noteText = v31AssistantNotesText(assistantNotes);
    if (noteText) threadNotes.push('ASSISTANT DESK INPUTS\n' + noteText);
  } catch (e) { console.warn('[v31 assistant prep notes]', e.message || e); }

  // v29.2: if Graph gives us a recurring series key, use it before fuzzy title matching.
  // This finds the previous instance of the same recurring meeting without relying on attendees or organiser.
  const recurrenceOr = [];
  const seriesKey = String(ev.seriesMasterId || ev.recurringSeriesMasterId || '').trim();
  const icalKey = String(ev.iCalUId || ev.icalUId || ev.icalUid || '').trim();
  if (seriesKey) recurrenceOr.push({ seriesMasterId: seriesKey });
  if (icalKey) recurrenceOr.push({ iCalUId: icalKey });
  if (recurrenceOr.length) {
    const priorEvents = await EventCache.find({
      orgId,
      userEmail: me,
      $or: recurrenceOr,
      startDateTime: { $lt: eventStartIso },
      hasTranscript: true,
    }).select({ eventId:1, subject:1, startDateTime:1, transcripts:1 })
      .sort({ startDateTime:-1 })
      .limit(Math.max(8, docLimit * 4))
      .lean();
    const priorEventIds = [...new Set(priorEvents.map(e => String(e.eventId || '')).filter(Boolean))];
    const priorDocIds = [...new Set(priorEvents.flatMap(e => (e.transcripts || []).map(r => String(r.transcriptDocId || '')).filter(Boolean)))].filter(id => mongoose.Types.ObjectId.isValid(id));
    const or = [];
    if (priorEventIds.length) or.push({ eventId: { $in: priorEventIds } });
    if (priorDocIds.length) or.push({ _id: { $in: priorDocIds } });
    if (or.length) {
      const recurringDocs = await Transcript.find({ orgId, 'acl.allowedEmails': { $in: principals }, $or: or, startDateTime: { $lt: eventStartIso }, ...v274TranscriptPayloadQuery() })
        .select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
        .sort({ startDateTime:-1 })
        .limit(Math.max(8, docLimit * 4))
        .lean();
      for (const d of recurringDocs) docsById.set(String(d._id), { doc: d, basis: 'recurring series' });
      if (!matchBasis && recurringDocs.length) matchBasis = 'recurring series';
    }
  }
  for (const item of threadMap.values()) {
    const t = item.thread;
    if (!matchBasis) matchBasis = item.basis || 'linked thread';
    const ids = (t.meetingIds || []).filter(Boolean);
    if (ids.length) {
      const docs = await Transcript.find({
        _id: { $in: ids },
        orgId,
        'acl.allowedEmails': { $in: principals },
        startDateTime: { $lt: eventStartIso },
        ...v274TranscriptPayloadQuery(),
      }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
        .sort({ startDateTime:-1 })
        .limit(8)
        .lean();
      for (const d of docs) docsById.set(String(d._id), { doc: d, basis: 'linked thread' });
      const meetingById = new Map(docs.map(d => [String(d._id), d]));
      const notes = v283ThreadNoteText(t.entries || [], me, noteLimit, meetingById);
      if (notes) threadNotes.push(`Thread: ${t.name || 'Thread'}
${notes}`);
    } else {
      const notes = v283ThreadNoteText(t.entries || [], me, noteLimit);
      if (notes) threadNotes.push(`Thread: ${t.name || 'Thread'}
${notes}`);
    }
  }

  if ((!docsById.size || docsById.size < docLimit) && key && key.length >= 3) {
    const since = new Date();
    since.setDate(since.getDate() - 450);
    const candidates = await Transcript.find({
      orgId,
      'acl.allowedEmails': { $in: principals },
      startDateTime: { $gte: since.toISOString(), $lt: eventStartIso },
      ...v274TranscriptPayloadQuery(),
    }).select({ _id:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 })
      .sort({ startDateTime:-1 })
      .limit(450)
      .lean();
    for (const d of candidates) {
      if (docsById.has(String(d._id))) continue;
      if (v283RelatedKey(subject, d.subject || '')) {
        docsById.set(String(d._id), { doc: d, basis: 'normalized title' });
      }
      if (docsById.size >= Math.max(docLimit, 6)) break;
    }
    if (!matchBasis && docsById.size) matchBasis = 'normalized title';
  }

  const weighted = [...docsById.values()]
    .sort((a,b)=>Date.parse(b.doc.startDateTime || '') - Date.parse(a.doc.startDateTime || ''))
    .slice(0, docLimit)
    .map((x, idx) => ({
      ...x,
      weight: idx === 0 ? 'High' : idx === 1 ? 'Medium' : 'Low',
      weightPct: idx === 0 ? 70 : idx === 1 ? 20 : 10,
    }));
  return {
    subjectKey: key,
    matchBasis: matchBasis || 'no related history found',
    threads: [...threadMap.values()].map(x => ({ id: String(x.thread._id), name: x.thread.name || 'Thread', basis: x.basis })),
    docs: weighted,
    notes: threadNotes.join('\n\n---\n\n'),
  };
}
function v283BuildPrepContext(event, history) {
  const lines = [];
  lines.push(`UPCOMING MEETING\nTitle: ${event.subject}\nTime: ${event.startDateTime || ''}\nMatch basis: ${history.matchBasis}\nMatching rule: linked thread first; otherwise normalized meeting title. People/attendees/organizer are intentionally NOT used.`);
  if (history.threads && history.threads.length) {
    lines.push('RELATED THREADS\n' + history.threads.map((t,i)=>`${i+1}. ${t.name} — ${t.basis}`).join('\n'));
  }
  if (history.docs && history.docs.length) {
    lines.push('RELATED PREVIOUS MEETINGS\n' + history.docs.map((x,i)=>{
      const d = x.doc;
      return `${i+1}. ${d.subject || 'Meeting'}\nDate: ${d.startDateTime || ''}\nWeight: ${x.weight} (${x.weightPct}%)\nEvidence:\n${v283EvidenceText(d, i === 0 ? 7600 : 4200) || 'No usable transcript/summary text.'}`;
    }).join('\n\n---\n\n'));
  }
  if (history.notes) lines.push('RELATED THREAD NOTES\n' + history.notes.slice(0, 9000));
  return lines.join('\n\n====================\n\n');
}
async function v283GenerateMeetingPrep(req, event) {
  const history = await v283FindPrepHistory(req, event, { docLimit: 3, noteLimit: 8 });
  const context = v283BuildPrepContext(event, history);
  const sources = history.docs.map((x, i) => ({
    title: x.doc.subject || 'Meeting',
    startDateTime: x.doc.startDateTime || '',
    match: x.basis,
    weight: x.weight,
    weightPct: x.weightPct,
    href: `/user/transcript/saved/${x.doc._id}/summary`,
  })).concat((history.threads || []).map(t => ({ title: `Thread: ${t.name}`, match: t.basis, href: `/user/threads/${t.id}` })));
  if (!history.docs.length && !history.notes) {
    return {
      title: `Prepare for ${event.subject || 'meeting'}`,
      answer: 'I could not find related meeting history yet. Link this meeting to a thread, or refresh/load transcripts for earlier meetings with the same title.\n\nFor now, go in with three simple questions:\n- What moved since the last discussion?\n- What is blocked or waiting for a decision?\n- What needs to be closed before the next meeting?',
      model: 'deterministic-v28.3',
      sources,
      matchBasis: history.matchBasis,
    };
  }
  const question = `Help me prepare for the upcoming meeting "${event.subject || 'Meeting'}".

Use the latest related meeting as the anchor with very high weight. Use the previous two related meetings only as background.

Important: do NOT use attendee overlap, organizer, speaker names, or owner labels. Do NOT say "Person X said". If names appear in the evidence, convert them into topic/workstream/client/team phrasing unless the name is part of a customer/project title.

Output exactly:
### Prep Snapshot
2-3 crisp lines on what this meeting is likely about.

### What to Ask
5-7 practical questions to ask, grounded in the last meeting first.

### What May Come Back
Recurring topics/issues from the last one to three meetings.

### Watch-outs
Risks, blockers, dependencies, or missing closures to watch.

### Suggested Opening Note
A short opening sentence I can say.

End with a one-line AI caution in a light Ms. Minutes tone.`;
  try {
    const answered = await generateMeetingAnswer({ question, context: context.slice(0, 34000), subject: event.subject || 'Meeting prep' });
    return { title: `Prepare for ${event.subject || 'meeting'}`, answer: answered.answer, model: answered.model, sources, matchBasis: history.matchBasis };
  } catch (e) {
    return { title: `Prepare for ${event.subject || 'meeting'}`, answer: `Could not run AI just now.\n\nFallback context:\n${context.slice(0, 4200)}`, model: 'fallback-v28.3', sources, matchBasis: history.matchBasis };
  }
}


async function v29GenerateMeetingPrepCached(req, event, { force = false } = {}) {
  const history = await v283FindPrepHistory(req, event, { docLimit: 3, noteLimit: 8 });
  const context = v283BuildPrepContext(event, history);
  const sources = history.docs.map((x) => ({
    title: x.doc.subject || 'Meeting',
    startDateTime: x.doc.startDateTime || '',
    match: x.basis,
    weight: x.weight,
    weightPct: x.weightPct,
    href: `/user/transcript/saved/${x.doc._id}/summary`,
  })).concat((history.threads || []).map(t => ({ title: `Thread: ${t.name}`, match: t.basis, href: `/user/threads/${t.id}` })));
  const scopeKey = v29MeetingScopeKey(event);
  const sourceHash = v29Hash({ event:[event.subject, event.startDateTime, event.endDateTime, scopeKey], context: context.slice(0, 36000), sources });
  const allowedEmails = v29CacheAllowedEmails(req, event.attendeeEmails || []);
  const cached = await IntelligenceCache.findOne({ orgId:req.user.org._id, scopeType:'meeting', scopeKey, kind:'prepare', 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).sort({ generatedAt:-1 }).lean();
  if (cached && !force && cached.sourceHash === sourceHash && cached.answer) {
    return { title: cached.title, answer: cached.answer, model: cached.model, sources: cached.sources || [], matchBasis: history.matchBasis, generatedAt: cached.generatedAt, generatedAtLabel: v29GeneratedLabel(cached.generatedAt), cached: true };
  }
  let out;
  if (!history.docs.length && !history.notes) {
    out = { title: `Prepare for ${event.subject || 'meeting'}`, answer:'I could not find related meeting history yet. Link this meeting to a thread, or refresh/load transcripts for earlier meetings with the same title.\n\nFor now, go in with three simple questions:\n- What moved since the last discussion?\n- What is blocked or waiting for a decision?\n- What needs to be closed before the next meeting?', model:'deterministic-v29', sources, matchBasis: history.matchBasis };
  } else {
    const question = `Help me prepare for the upcoming meeting "${event.subject || 'Meeting'}".

Use the latest related meeting as the anchor with very high weight. Use the previous two related meetings only as background.

Important: do NOT use attendee overlap, organizer, speaker names, or owner labels. Do NOT say "Person X said". If names appear in the evidence, convert them into topic/workstream/client/team phrasing unless the name is part of a customer/project title.

Output exactly:
### Prep Snapshot
2-3 crisp lines on what this meeting is likely about.

### What to Ask
5-7 practical questions to ask, grounded in the last meeting first.

### What May Come Back
Recurring topics/issues from the last one to three meetings.

### Watch-outs
Risks, blockers, dependencies, or missing closures to watch.

### Suggested Opening Note
A short opening sentence I can say.

End with a one-line AI caution in a light Ms. Minutes tone.`;
    try {
      const answered = await generateMeetingAnswer({ question, context: context.slice(0, 34000), subject: event.subject || 'Meeting prep' });
      out = { title: `Prepare for ${event.subject || 'meeting'}`, answer: answered.answer, model: answered.model, sources, matchBasis: history.matchBasis };
    } catch (e) {
      out = { title: `Prepare for ${event.subject || 'meeting'}`, answer: `Could not run AI just now.\n\nFallback context:\n${context.slice(0, 4200)}`, model:'fallback-v29', sources, matchBasis: history.matchBasis };
    }
  }
  const saved = await IntelligenceCache.findOneAndUpdate(
    { orgId:req.user.org._id, scopeType:'meeting', scopeKey, kind:'prepare' },
    { $set:{ title:out.title, answer:out.answer, model:out.model || '', sources:out.sources || [], sourceHash, generatedAt:new Date(), generatedBy:req.user._id, generatedByEmail:req.user.email, acl:{ allowedEmails, updatedAt:new Date() } }, $inc:{ refreshCount:1 } },
    { upsert:true, new:true }
  ).lean();
  return { ...out, cacheId: String(saved._id), review: saved.review || { status:'unreviewed' }, generatedAt: saved.generatedAt, generatedAtLabel: v29GeneratedLabel(saved.generatedAt), cached: false };
}

router.get('/intelligence', requireUser, ensureUserFreshToken, async (req, res, next) => {
  const now = new Date();
  const focusRange = v285IntelligenceFocusRange(now);
  const weekEnd = addDays(now, 7);
  let error = null;
  let refreshed = false;
  try {
    if (String(req.query.refresh || '') === '1') {
      await v283RefreshUpcomingMeetingCache(req, res, now, weekEnd);
      refreshed = true;
    }
    const [upcomingMeetings, weekUpcomingMeetings, weekMeetingCount, lastCached] = await Promise.all([
      v285UpcomingMeetingsBetween(req, now, focusRange.end, 40),
      v285UpcomingMeetingsBetween(req, now, weekEnd, 80),
      EventCache.countDocuments({ orgId: req.user.org._id, userEmail: String(req.user.email || '').toLowerCase().trim(), startDateTime: { $gte: now.toISOString(), $lte: weekEnd.toISOString() } }),
      EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email || '').toLowerCase().trim() }).sort({ syncedAt:-1 }).select({ syncedAt:1 }).lean(),
    ]);
    return res.render('user/intelligence', {
      title: 'Intelligence',
      fullBleed: true,
      activeNav: 'intelligence',
      user: req.user,
      org: req.user.org,
      upcomingMeetings,
      weekUpcomingMeetings,
      weekMeetingCount,
      upcomingRangeLabel: focusRange.label,
      refreshed,
      error,
      lastSyncedAt: lastCached?.syncedAt || null,
      lastSyncedAtLabel: lastCached?.syncedAt ? v27LastSyncLabel(lastCached.syncedAt) : '',
    });
  } catch (e) {
    error = e.message || String(e);
    try {
      const focusRange = v285IntelligenceFocusRange(new Date());
      const upcomingMeetings = await v285UpcomingMeetingsBetween(req, new Date(), focusRange.end, 40);
      return res.render('user/intelligence', { title: 'Intelligence', fullBleed: true, activeNav: 'intelligence', user: req.user, org: req.user.org, upcomingMeetings, weekUpcomingMeetings: upcomingMeetings, weekMeetingCount: upcomingMeetings.length, upcomingRangeLabel: focusRange.label, refreshed, error, lastSyncedAt: null, lastSyncedAtLabel: '' });
    } catch (inner) { return next(e); }
  }
});

router.get('/intelligence/prepare', requireUser, async (req, res, next) => {
  try {
    const eventId = String(req.query.eventId || '').trim();
    if (!eventId) return res.status(400).json({ ok:false, error:'Missing meeting event id' });
    const ev = await EventCache.findOne({ orgId: req.user.org._id, userEmail: String(req.user.email || '').toLowerCase().trim(), eventId }).lean();
    if (!ev) return res.status(404).json({ ok:false, error:'Meeting not found in your upcoming meeting cache. Refresh Intelligence first.' });
    const out = await v29GenerateMeetingPrepCached(req, ev, { force: String(req.query.refresh || '') === '1' });
    return res.json({ ok:true, ...out });
  } catch (e) { return next(e); }
});

router.get('/intelligence/week-ahead', requireUser, async (req, res, next) => {
  try {
    const upcoming = await v283UpcomingMeetings(req, 7, 10);
    if (!upcoming.length) return res.json({ ok:true, title:'Prepare me for the week ahead', answer:'No upcoming meetings found in the next 7 days. Refresh Intelligence from Outlook first, then Ms. Minutes can do its tiny-prep magic. 🐣', sources:[], model:'deterministic-v28.3' });
    const sections = [];
    const sources = [];
    for (const ev of upcoming.slice(0, 8)) {
      const history = await v283FindPrepHistory(req, ev, { docLimit: 2, noteLimit: 4 });
      sections.push(`UPCOMING: ${ev.subject}\nTime: ${ev.startDateTime}\nMatch basis: ${history.matchBasis}\n` + (history.docs || []).map((x,i)=>`History ${i+1}: ${x.doc.subject} — ${x.weight} weight\n${v283EvidenceText(x.doc, i === 0 ? 4200 : 2600)}`).join('\n\n---\n\n') + (history.notes ? `\n\nThread notes:\n${history.notes.slice(0, 4000)}` : ''));
      for (const x of history.docs || []) sources.push({ title: x.doc.subject || 'Meeting', startDateTime: x.doc.startDateTime || '', match: x.basis, weight: x.weight, href: `/user/transcript/saved/${x.doc._id}/summary` });
    }
    sources.sort((a,b) => (Number(b.score || 0) - Number(a.score || 0)) || (new Date(b.date || 0) - new Date(a.date || 0)));
    const rankedSections = sections.slice(0, 18);
    const context = rankedSections.join('\n\n====================\n\n').slice(0, 36000);
    const question = `Prepare me for the week ahead based on upcoming meetings and their matched history.

Important: We do not have a structured action tracker yet. Do not pretend actions are calculated. Infer only practical follow-up questions and prep themes from the supplied summaries/transcripts/notes.

Do not use attendee/organizer/speaker names. Focus on meeting titles, clients, workstreams, topics, risks, decisions, and unresolved follow-up areas.

Output exactly:
### Week Ahead Snapshot
3-4 bullets on what the week appears to be about.

### Meetings Worth Preparing For
For each high-prep meeting, give the meeting name and the prep angle.

### Questions to Keep Ready
A consolidated list of practical questions to ask this week.

### Watch-outs
Risks, blockers, repeated topics, or missing closures.

### Tiny Ms. Minutes Note
A humorous AI caution line.`;
    try {
      const answered = await generateMeetingAnswer({ question, context, subject: 'Week ahead preparation' });
      return res.json({ ok:true, title:'Prepare me for the week ahead', answer: answered.answer, model: answered.model, sources: sources.slice(0, 12) });
    } catch (e) {
      return res.json({ ok:true, title:'Prepare me for the week ahead', answer:`Could not run AI just now.\n\nFallback context:\n${context.slice(0, 5000)}`, model:'fallback-v28.3', sources: sources.slice(0,12) });
    }
  } catch (e) { return next(e); }
});

// v31: user settings/profile with Assistant Desk delegation.
router.get('/settings', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    const [users, freshUser, assistantsForMe, peopleIAssist] = await Promise.all([
      User.find({ org: req.user.org._id, status: 'active' }).select({ name:1, email:1, role:1, department:1, designation:1 }).sort({ name:1, email:1 }).lean(),
      User.findById(req.user._id).lean(),
      AssistantMapping.find({ orgId:req.user.org._id, principalEmail:me, active:true }).sort({ createdAt:-1 }).lean(),
      AssistantMapping.find({ orgId:req.user.org._id, assistantEmail:me, active:true }).sort({ createdAt:-1 }).lean(),
    ]);
    return res.render('user/settings', { title:'My Settings', fullBleed:true, activeNav:'settings', user:{ ...req.user, ...(freshUser || {}) }, org:req.user.org, users, assistantsForMe, peopleIAssist, saved:Boolean(req.query.saved) });
  } catch(e) { return next(e); }
});

router.post('/settings/profile', requireUser, async (req, res, next) => {
  try {
    await User.updateOne({ _id:req.user._id }, { $set:{
      name:String(req.body.name || req.user.name || '').trim(),
      department:String(req.body.department || '').trim(),
      designation:String(req.body.designation || '').trim(),
      preferences:{
        summaryStyle:['balanced','executive','detailed'].includes(req.body.summaryStyle) ? req.body.summaryStyle : 'balanced',
        includeDetailedNotesByDefault:v31Bool(req.body.includeDetailedNotesByDefault, false),
        includeActionItemsByDefault:v31Bool(req.body.includeActionItemsByDefault, false),
        aiTone:['practical','brief','warm','direct'].includes(req.body.aiTone) ? req.body.aiTone : 'practical',
      }
    } });
    await writeAudit(req, 'USER_SETTINGS_UPDATED', 'User', req.user._id, 'Updated personal settings');
    return res.redirect('/user/settings?saved=1');
  } catch(e) { return next(e); }
});

router.post('/settings/assistants', requireUser, async (req, res, next) => {
  try {
    const assistantEmail = String(req.body.assistantEmail || req.body.email || '').toLowerCase().trim();
    if (!assistantEmail) return res.redirect('/user/settings');
    const assistant = await User.findOne({ org:req.user.org._id, email:assistantEmail }).select({ _id:1, name:1, email:1 }).lean();
    const me = String(req.user.email || '').toLowerCase().trim();
    const assistantName = String(req.body.assistantName || assistant?.name || '').trim();
    await AssistantMapping.findOneAndUpdate(
      { orgId:req.user.org._id, principalEmail:me, assistantEmail },
      { $set:{ principalUserId:req.user._id, principalEmail:me, principalName:req.user.name || me, assistantUserId:assistant?._id || null, assistantEmail, assistantName:assistantName || assistantEmail, permissions:v31AssistantPermissionsFromBody(req.body), source:'user', active:true, removedAt:null, removedByEmail:'', createdByEmail:me } },
      { upsert:true, new:true, setDefaultsOnInsert:true }
    );
    await User.updateOne({ _id:req.user._id }, { $pull:{ collaborators:{ email:assistantEmail } } });
    await User.updateOne({ _id:req.user._id }, { $push:{ collaborators:{ email:assistantEmail, name:assistantName || assistantEmail, role:'assistant', canAddContext:true, canAddActions:v31Bool(req.body.canAddFollowups, true), addedAt:new Date() } } });
    await writeAudit(req, 'ASSISTANT_MAPPING_ADDED', 'AssistantMapping', req.user._id, `Added assistant ${assistantEmail}`);
    return res.redirect('/user/settings?saved=1#assistant-desk');
  } catch(e) { return next(e); }
});

router.post('/settings/assistants/remove', requireUser, async (req, res, next) => {
  try {
    const assistantEmail = String(req.body.assistantEmail || '').toLowerCase().trim();
    const me = String(req.user.email || '').toLowerCase().trim();
    if (assistantEmail) {
      await AssistantMapping.updateOne({ orgId:req.user.org._id, principalEmail:me, assistantEmail }, { $set:{ active:false, removedAt:new Date(), removedByEmail:me } });
      await User.updateOne({ _id:req.user._id }, { $pull:{ collaborators:{ email:assistantEmail } } });
      await writeAudit(req, 'ASSISTANT_MAPPING_REMOVED', 'AssistantMapping', req.user._id, `Removed assistant ${assistantEmail}`);
    }
    return res.redirect('/user/settings?saved=1#assistant-desk');
  } catch(e) { return next(e); }
});

// v31: Assistant Desk. Assistants can add notes/questions for principals without reading restricted content.
router.get('/assistant', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    const [peopleIAssist, assistantsForMe, notesForMe, notesByMe, recentMeetings, myThreads] = await Promise.all([
      AssistantMapping.find({ orgId:req.user.org._id, assistantEmail:me, active:true }).sort({ principalName:1, principalEmail:1 }).lean(),
      AssistantMapping.find({ orgId:req.user.org._id, principalEmail:me, active:true }).sort({ assistantName:1, assistantEmail:1 }).lean(),
      AssistantNote.find({ orgId:req.user.org._id, principalEmail:me }).sort({ createdAt:-1 }).limit(60).lean(),
      AssistantNote.find({ orgId:req.user.org._id, assistantEmail:me }).sort({ createdAt:-1 }).limit(60).lean(),
      EventCache.find({ orgId:req.user.org._id, userEmail:me }).select({ eventId:1, subject:1, startDateTime:1, endDateTime:1 }).sort({ startDateTime:-1 }).limit(80).lean(),
      MeetingThread.find(threadAccessQuery(req)).select({ name:1, status:1, updatedAt:1 }).sort({ updatedAt:-1 }).limit(80).lean(),
    ]);
    return res.render('user/assistant_desk', { title:'Assistant Desk', fullBleed:true, activeNav:'assistant', user:req.user, org:req.user.org, peopleIAssist, assistantsForMe, notesForMe, notesByMe, recentMeetings, myThreads, noteTypeLabel:v31NoteTypeLabel });
  } catch(e) { return next(e); }
});

router.post('/assistant/notes-v31', requireUser, async (req, res, next) => {
  try {
    const principalEmail = String(req.body.principalEmail || '').toLowerCase().trim();
    const me = String(req.user.email || '').toLowerCase().trim();
    if (!principalEmail) return res.redirect('/user/assistant');
    const mapping = await AssistantMapping.findOne({ orgId:req.user.org._id, principalEmail, assistantEmail:me, active:true }).lean();
    const selfNote = principalEmail === me;
    if (!mapping && !selfNote) return res.status(403).send('You are not allowed to add Assistant Desk notes for this person.');
    const noteType = ['question','prep','followup','risk','decision','general','thread_note','meeting_note'].includes(req.body.noteType) ? req.body.noteType : 'general';
    const targetType = ['general','meeting','thread'].includes(req.body.targetType) ? req.body.targetType : 'general';
    if (targetType === 'meeting' && !mapping?.permissions?.canAddMeetingNotes && !selfNote) return res.status(403).send('Meeting notes are not allowed for this assistant mapping.');
    if (targetType === 'thread' && !mapping?.permissions?.canAddThreadNotes && !selfNote) return res.status(403).send('Thread notes are not allowed for this assistant mapping.');
    if (noteType === 'question' && !mapping?.permissions?.canAddQuestions && !selfNote) return res.status(403).send('Questions are not allowed for this assistant mapping.');
    const body = v281SanitizeRichThreadNote(req.body.body || req.body.note || '');
    if (!body) return res.redirect('/user/assistant');
    const principal = await User.findOne({ org:req.user.org._id, email:principalEmail }).select({ _id:1, name:1, email:1 }).lean();
    let targetTitle = String(req.body.targetTitle || '').trim();
    let eventId = '';
    let threadId = null;
    if (targetType === 'meeting') {
      eventId = String(req.body.eventId || '').trim();
      const ev = eventId ? await EventCache.findOne({ orgId:req.user.org._id, eventId, $or:[{ userEmail:principalEmail }, { userEmail:me }] }).select({ subject:1, startDateTime:1 }).lean() : null;
      targetTitle = targetTitle || ev?.subject || eventId || 'Meeting';
    }
    if (targetType === 'thread') {
      const rawThreadId = String(req.body.threadId || '').trim();
      if (mongoose.Types.ObjectId.isValid(rawThreadId)) threadId = rawThreadId;
      const th = threadId ? await MeetingThread.findOne({ orgId:req.user.org._id, _id:threadId }).select({ name:1 }).lean() : null;
      targetTitle = targetTitle || th?.name || 'Thread';
    }
    const note = await AssistantNote.create({
      orgId:req.user.org._id,
      principalUserId:principal?._id || null,
      principalEmail,
      principalName:principal?.name || mapping?.principalName || principalEmail,
      assistantUserId:req.user._id,
      assistantEmail:me,
      assistantName:req.user.name || me,
      targetType,
      eventId,
      threadId,
      targetTitle,
      noteType,
      title:String(req.body.title || '').trim(),
      body,
      acl:{ allowedEmails:uniqEmails([principalEmail, me]), updatedAt:new Date() },
    });
    await writeAudit(req, 'ASSISTANT_NOTE_ADDED', 'AssistantNote', note._id, `Added Assistant Desk note for ${principalEmail}`, { targetType, noteType, eventId, threadId });
    return res.redirect(req.body.returnTo || '/user/assistant');
  } catch(e) { return next(e); }
});

router.post('/assistant/notes/:id/seen', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    await AssistantNote.updateOne({ _id:req.params.id, orgId:req.user.org._id, principalEmail:me }, { $set:{ status:'seen', seenAt:new Date(), seenByEmail:me } });
    return res.redirect(req.body.returnTo || '/user/assistant');
  } catch(e) { return next(e); }
});

// v31/v31.3: Manual meeting links — trusted human context across differently-named meetings.
router.get('/meeting-links/search', requireUser, async (req, res) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    const q = String(req.query.q || '').trim();
    const excludeEventId = String(req.query.excludeEventId || '').trim();
    if (q.length < 3) return res.json({ ok:true, meetings:[], cachedOnly:true });
    const rx = v31SearchRegex(q);
    // v31.4: connection search is cache-only and intentionally does not call Graph.
    // This prevents modal errors and makes the rule clear: refresh Outlook first, then connect.
    const meetings = await EventCache.find({
      orgId:req.user.org._id,
      userEmail:me,
      eventId: { $ne: excludeEventId },
      $or: [{ subject: rx }, { organizerEmail: rx }, { startDateTime: rx }]
    })
      .select({ eventId:1, iCalUId:1, subject:1, startDateTime:1, endDateTime:1, organizerEmail:1, attendeeEmails:1, hasTranscript:1 })
      .sort({ startDateTime:-1 })
      .limit(40)
      .lean();
    return res.json({ ok:true, cachedOnly:true, meetings: meetings.map(m => ({
      eventId: m.eventId,
      subject: m.subject || 'Untitled meeting',
      startDateTime: m.startDateTime || '',
      dateLabel: m.startDateTime ? new Date(m.startDateTime).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' }) : '',
      organiser: m.organizerEmail || '',
      hasTranscript: !!m.hasTranscript,
    })) });
  } catch(e) {
    console.warn('[meeting-links/search] cache-only search failed:', e.message);
    return res.json({ ok:false, cachedOnly:true, meetings:[], error:'Could not load cached meetings right now.' });
  }
});

router.get('/faq', requireUser, async (req, res) => {
  return res.render('user/faq', { title:'Ms. Minutes FAQ', fullBleed:true, activeNav:'faq', user:req.user, org:req.user.org });
});

router.get('/meeting-links', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    const q = String(req.query.q || '').trim();
    const fromEventId = String(req.query.fromEventId || '').trim();
    const terms = q ? v31SearchRegex(q) : null;
    const meetingQuery = { orgId:req.user.org._id, userEmail:me };
    if (terms) meetingQuery.subject = terms;
    const [meetings, existingLinks, fromMeeting] = await Promise.all([
      EventCache.find(meetingQuery).select({ eventId:1, iCalUId:1, subject:1, startDateTime:1, endDateTime:1, hasTranscript:1, organizerEmail:1, attendeeEmails:1 }).sort({ startDateTime:-1 }).limit(180).lean(),
      MeetingLink.find({ orgId:req.user.org._id, active:true, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }).sort({ createdAt:-1 }).limit(120).lean(),
      fromEventId ? EventCache.findOne({ orgId:req.user.org._id, userEmail:me, eventId:fromEventId }).select({ eventId:1, iCalUId:1, subject:1, startDateTime:1 }).lean() : null,
    ]);
    const nodes = new Map();
    const edges = [];
    for (const l of existingLinks || []) {
      const a = l.fromEventId || l.fromICalUId || l.fromSubject;
      const b = l.toEventId || l.toICalUId || l.toSubject;
      if (!a || !b) continue;
      nodes.set(a, { id:a, title:l.fromSubject || a, date:l.fromStartDateTime || '' });
      nodes.set(b, { id:b, title:l.toSubject || b, date:l.toStartDateTime || '' });
      edges.push({ from:a, to:b, relation:l.relation, reason:l.reason || '', createdByEmail:l.createdByEmail || '' });
    }
    return res.render('user/meeting_links', { title:'Connect meetings', fullBleed:true, activeNav:'meeting-links', user:req.user, org:req.user.org, q, meetings, existingLinks, fromEventId, fromMeeting, relationLabel:v31RelationLabel, me, graph:{ nodes:[...nodes.values()], edges } });
  } catch(e) { return next(e); }
});

router.post('/meeting-links', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    const baseEventId = String(req.body.fromEventId || req.body.baseEventId || '').trim();
    const targetEventId = String(req.body.toEventId || req.body.targetEventId || '').trim();
    const linkMode = String(req.body.linkMode || '').trim();
    let relation = ['precursor_to','followup_to','continues','provides_context_for','resulted_from','related_to'].includes(req.body.relation) ? req.body.relation : 'precursor_to';
    if (!baseEventId || !targetEventId || baseEventId === targetEventId) return res.redirect(req.body.returnTo || '/user/meeting-links');
    const [baseEv, targetEv] = await Promise.all([
      EventCache.findOne({ orgId:req.user.org._id, userEmail:me, eventId:baseEventId }).lean(),
      EventCache.findOne({ orgId:req.user.org._id, userEmail:me, eventId:targetEventId }).lean(),
    ]);
    if (!baseEv || !targetEv) {
      const back = req.body.returnTo || '/user/meeting-links';
      return res.redirect(back + (back.includes('?') ? '&' : '?') + 'connectError=' + encodeURIComponent('Both meetings must already be in your Ms. Minutes cache. Refresh Outlook first, then connect.'));
    }
    let fromEv = baseEv;
    let toEv = targetEv;
    if (linkMode === 'current_successor') {
      // User says: current/base meeting is a successor of selected target. Store target -> base as the precursor chain.
      fromEv = targetEv;
      toEv = baseEv;
      relation = 'precursor_to';
    } else if (linkMode === 'current_precursor') {
      fromEv = baseEv;
      toEv = targetEv;
      relation = 'precursor_to';
    }
    const allowedEmails = v313MeetingLinkAcl(req, fromEv, toEv);
    await MeetingLink.findOneAndUpdate(
      { orgId:req.user.org._id, fromEventId:fromEv.eventId, toEventId:toEv.eventId, relation },
      { $set:{
          fromICalUId: fromEv.iCalUId || '',
          toICalUId: toEv.iCalUId || '',
          fromSubject:fromEv.subject || '',
          toSubject:toEv.subject || '',
          fromStartDateTime:fromEv.startDateTime || '',
          toStartDateTime:toEv.startDateTime || '',
          fromOrganizerEmail: String(fromEv.organizerEmail || '').toLowerCase().trim(),
          toOrganizerEmail: String(toEv.organizerEmail || '').toLowerCase().trim(),
          fromAttendeeEmails: v313MeetingPeople(fromEv),
          toAttendeeEmails: v313MeetingPeople(toEv),
          reason:String(req.body.reason || '').trim(),
          active:true,
          createdBy:req.user._id,
          createdByEmail:me,
          acl:{ allowedEmails, updatedAt:new Date() }
        } },
      { upsert:true, new:true, setDefaultsOnInsert:true }
    );
    await writeAudit(req, 'MANUAL_MEETING_LINK_ADDED', 'MeetingLink', fromEv.eventId + '>' + toEv.eventId, `Connected meetings: ${fromEv.subject} → ${toEv.subject}`, { relation, linkMode });
    return res.redirect(req.body.returnTo || ('/user/meeting-links?fromEventId=' + encodeURIComponent(baseEventId)));
  } catch(e) { return next(e); }
});

router.post('/meeting-links/:id/delete', requireUser, async (req, res, next) => {
  try {
    const me = String(req.user.email || '').toLowerCase().trim();
    await MeetingLink.updateOne({ _id:req.params.id, orgId:req.user.org._id, createdByEmail:me }, { $set:{ active:false } });
    return res.redirect(req.body.returnTo || '/user/meeting-links');
  } catch(e) { return next(e); }
});

// v31: What did I discuss? Topic recall across accessible transcripts, notes, threads and Assistant Desk inputs.
router.get('/recall', requireUser, async (req, res, next) => {
  try {
    const meetingOptions = await v312RecallMeetingOptions(req);
    return res.render('user/recall', { title:'What did I discuss?', fullBleed:true, activeNav:'recall', user:req.user, org:req.user.org, result:null, meetingOptions, form:{ topic:'', from:'', to:'', scope:'all', quickRange:'', focusMeetingId:'' } });
  } catch(e) { return next(e); }
});

router.post('/recall', requireUser, async (req, res, next) => {
  try {
    const topic = String(req.body.topic || '').trim();
    const quickRange = ['3d','7d','15d','30d'].includes(String(req.body.quickRange || '')) ? String(req.body.quickRange) : '';
    const quick = v312ApplyQuickRange(quickRange);
    const from = quick ? quick.from : String(req.body.from || '').trim();
    const to = quick ? quick.to : String(req.body.to || '').trim();
    const scope = ['all','meetings','threads','notes','assistant'].includes(req.body.scope) ? req.body.scope : 'all';
    const focusMeetingId = String(req.body.focusMeetingId || '').trim();
    const meetingOptions = await v312RecallMeetingOptions(req);
    if (!topic) return res.render('user/recall', { title:'What did I discuss?', fullBleed:true, activeNav:'recall', user:req.user, org:req.user.org, result:{ error:'Enter a topic first.' }, meetingOptions, form:{ topic, from, to, scope, quickRange, focusMeetingId } });
    const profile = v311TopicProfile(topic);
    const terms = profile.terms;
    const orgId = req.user.org._id;
    const principals = getUserPrincipals(req.user);
    let focusTranscript = null;
    if (focusMeetingId && mongoose.Types.ObjectId.isValid(focusMeetingId)) {
      focusTranscript = await Transcript.findOne({ _id: focusMeetingId, orgId, 'acl.allowedEmails': { $in: principals } }).select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1 }).lean();
    }
    const dateQ = {};
    const start = from ? new Date(from + 'T00:00:00') : null;
    const end = to ? new Date(to + 'T23:59:59') : null;
    if (start && Number.isFinite(start.getTime())) dateQ.$gte = start.toISOString();
    if (end && Number.isFinite(end.getTime())) dateQ.$lte = end.toISOString();
    const sections = [];
    const sources = [];

    if (scope === 'all' || scope === 'meetings') {
      const mq = { orgId, 'acl.allowedEmails': { $in: principals }, ...v274TranscriptPayloadQuery() };
      if (Object.keys(dateQ).length) mq.startDateTime = dateQ;
      if (focusTranscript) mq._id = focusTranscript._id;
      const docs = await Transcript.find(mq).select({ _id:1, eventId:1, subject:1, startDateTime:1, endDateTime:1, text:1, vtt:1, 'ai.summary':1, 'ai.detailedNotes':1 }).sort({ startDateTime:-1 }).limit(220).lean();
      for (const d of docs) {
        const text = [d.subject, d.ai?.summary, d.ai?.detailedNotes, d.text || d.vtt].filter(Boolean).join('\n');
        const rel = v311Relevance(text, profile);
        if (!rel.ok) continue;
        sections.push(`MEETING: ${d.subject || 'Meeting'}\nDate: ${d.startDateTime || ''}\nRelevance: ${rel.score}\n${v311RelevantClip(text, profile, 1400)}`);
        sources.push({ type:'Meeting', title:d.subject || 'Meeting', date:d.startDateTime || '', href:`/user/transcript/saved/${d._id}/summary`, score: rel.score });
        if (sections.length >= 18) break;
      }
    }

    if (scope === 'all' || scope === 'threads') {
      const threadQ = threadAccessQuery(req);
      if (focusTranscript) threadQ.meetingIds = focusTranscript._id;
      const threads = await MeetingThread.find(threadQ).select({ _id:1, name:1, objective:1, status:1, entries:1, updatedAt:1, meetingIds:1 }).sort({ updatedAt:-1 }).limit(180).lean();
      for (const t of threads) {
        const threadText = [t.name, t.objective, ...(t.entries || []).map(e => [e.title, e.body, e.sourceType, e.kind].join('\n'))].join('\n');
        const rel = v311Relevance(threadText, profile);
        const relevantEntries = (t.entries || []).filter(e => v311Relevance([e.title, e.body, e.sourceType, e.kind].join('\n'), profile).ok).slice(-8);
        if (!rel.ok && !relevantEntries.length) continue;
        sections.push(`THREAD: ${t.name}\nStatus: ${t.status || ''}\nRelevance: ${rel.score}\n${t.objective ? 'Objective: ' + t.objective + '\n' : ''}${relevantEntries.length ? relevantEntries.map(e => `${e.kind || 'note'} — ${e.title || ''}\n${v311RelevantClip(e.body || '', profile, 650)}`).join('\n---\n') : v311RelevantClip(threadText, profile, 950)}`);
        sources.push({ type:'Thread', title:t.name, date:t.updatedAt || '', href:`/user/threads/${t._id}`, score: rel.score });
        if (sections.length >= 28) break;
      }
    }

    if (scope === 'all' || scope === 'notes') {
      const cq = { orgId, 'acl.allowedEmails': { $in: principals } };
      if (focusTranscript) cq.$or = [{ transcriptDocId: focusTranscript._id }, { eventId: focusTranscript.eventId || '__no_event__' }];
      if (start || end) { cq.occurredAt = {}; if (start) cq.occurredAt.$gte = start; if (end) cq.occurredAt.$lte = end; }
      const notes = await MeetingContext.find(cq).sort({ occurredAt:-1, createdAt:-1 }).limit(220).lean();
      for (const n of notes) {
        const text = [n.title, n.contextText, n.fileText].filter(Boolean).join('\n');
        const rel = v311Relevance(text, profile);
        if (!rel.ok) continue;
        sections.push(`NOTE: ${n.title || n.sourceType || 'Note'}\nDate: ${n.occurredAt || n.createdAt || ''}\nRelevance: ${rel.score}\n${v311RelevantClip(text, profile, 900)}`);
        sources.push({ type:'Note', title:n.title || n.sourceType || 'Note', date:n.occurredAt || n.createdAt || '', score: rel.score });
        if (sections.length >= 34) break;
      }
    }

    if (scope === 'all' || scope === 'assistant') {
      const aq = { orgId, $or:[{ principalEmail:{ $in:principals.map(x=>String(x).toLowerCase()) } }, { assistantEmail:{ $in:principals.map(x=>String(x).toLowerCase()) } }, { 'acl.allowedEmails': { $in: principals } }] };
      if (focusTranscript) aq.eventId = focusTranscript.eventId || '__no_event__';
      if (start || end) { aq.createdAt = {}; if (start) aq.createdAt.$gte = start; if (end) aq.createdAt.$lte = end; }
      const assistantNotes = await AssistantNote.find(aq).sort({ createdAt:-1 }).limit(180).lean();
      for (const n of assistantNotes) {
        const text = [n.title, n.body, n.targetTitle, n.noteType].filter(Boolean).join('\n');
        const rel = v311Relevance(text, profile);
        if (!rel.ok) continue;
        sections.push(`ASSISTANT NOTE: ${v31NoteTypeLabel(n.noteType)} ${n.title || ''}\nFor: ${n.principalName || n.principalEmail}\nFrom: ${n.assistantName || n.assistantEmail}\nTarget: ${n.targetTitle || n.targetType}\nRelevance: ${rel.score}\n${v311RelevantClip(n.body, profile, 800)}`);
        sources.push({ type:'Assistant note', title:n.title || v31NoteTypeLabel(n.noteType), date:n.createdAt || '', href:'/user/assistant', score: rel.score });
        if (sections.length >= 40) break;
      }
    }

    let answer = '';
    sources.sort((a,b) => (Number(b.score || 0) - Number(a.score || 0)) || (new Date(b.date || 0) - new Date(a.date || 0)));
    const rankedSections = sections.slice(0, 18);
    const context = rankedSections.join('\n\n====================\n\n').slice(0, 36000);
    if (!sections.length) {
      answer = `I could not find accessible meeting memory about “${topic}” in the selected range. Try a broader term like pricing, commercial model, billing, revenue share, or expand the date range.`;
    } else {
      const question = `The user asked: What did I discuss about "${topic}"?\nTime range: ${from || 'beginning'} to ${to || 'now'}.${focusTranscript ? '\nFocus meeting: ' + (focusTranscript.subject || 'Selected meeting') + ' — use this meeting as the main anchor and only include related thread/note evidence if it is connected to this meeting.' : ''}\n\nUse only the supplied accessible meeting memory. Do not invent details. Do not merely list every meeting where the words appeared; synthesize the actual discussion, direction, decisions, open questions, and what to ask next. Ignore incidental one-off mentions unless they affected the discussion.\n\nOutput exactly:\n### What you discussed\nA concise executive summary.\n\n### Key themes\nBullets grouped by theme.\n\n### Timeline\nChronological points with dates when available.\n\n### Decisions / direction so far\nOnly decisions or clear direction supported by evidence.\n\n### Open questions\nWhat appears unresolved.\n\n### What to ask next\nPractical questions to use in the next meeting.\n\n### Sources used\nMention the source titles; do not quote long transcript passages.`;
      try {
        const out = await generateMeetingAnswer({ question, context, subject:`Topic recall: ${topic}` });
        answer = out.answer;
      } catch(e) {
        answer = `### What you discussed\n${sections.slice(0,5).map(v31Clip).join('\n\n')}\n\n### Sources used\n${sources.slice(0,10).map(s => `- ${s.type}: ${s.title}`).join('\n')}`;
      }
    }
    return res.render('user/recall', { title:'What did I discuss?', fullBleed:true, activeNav:'recall', user:req.user, org:req.user.org, result:{ topic, terms, answer, sources:sources.slice(0,18), count:sections.length, quickRange, focusMeeting: focusTranscript ? { id:String(focusTranscript._id), subject:focusTranscript.subject || 'Selected meeting', date:focusTranscript.startDateTime || '' } : null }, meetingOptions, form:{ topic, from, to, scope, quickRange, focusMeetingId } });
  } catch(e) { return next(e); }
});

[
  '/dashboard', '/actions', '/actions/new', '/audit', '/collaborators',
  '/people', '/summaries', '/transparency', '/mom-compose'
].forEach(path => router.get(path, requireUser, (req, res) => res.redirect('/user/home')));
router.get('/actions/:id', requireUser, (req, res) => res.redirect('/user/home'));
router.get('/people/:email', requireUser, (req, res) => res.redirect('/user/home'));



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
    const returnSummary = String(req.query.summary || '') === '1';
    const orgId = req.user.org?._id;

    const me = String(req.user.email || '').toLowerCase().trim();

    let doc = null;
    let graphTranscriptMeta = null;

    try {
      // v29.3: same Teams link can have many transcript occurrences.
      // Validate by calendar occurrence time before loading/reusing any transcript.
      const occurrenceEvent = { startDateTime: req.query.start || '', endDateTime: req.query.end || '' };
      if (occurrenceEvent.startDateTime || occurrenceEvent.endDateTime) {
        const listed = await listTranscripts(accessToken, meetingId);
        const items = Array.isArray(listed?.items) ? listed.items : [];
        const requested = items.find(t => String(t.id || t.transcriptId || '') === String(transcriptId));
        const best = pickBestTranscriptForEvent(items, occurrenceEvent);
        if (!requested || !best || String(best.id || best.transcriptId || '') !== String(transcriptId)) {
          return res.status(409).send('Transcript not ready for this meeting occurrence yet. Ms. Minutes found the same Teams link, but the transcript timestamp does not match this calendar event. Please try again after Teams finishes processing this occurrence.');
        }
        graphTranscriptMeta = best;
      }

      // Lookup only the exact occurrence first. Only use legacy meetingId+transcriptId fallback
      // when there is no eventId, or when the Graph transcript metadata proves this occurrence matches.
      doc = eventId ? await Transcript.findOne({ orgId, eventId, transcriptId }) : null;
      if (!doc && (!eventId || graphTranscriptMeta)) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
      if (doc && graphTranscriptMeta && doc.eventId && String(doc.eventId) !== String(eventId)) {
        doc = null;
      }

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
            transcriptCreatedDateTime: graphTranscriptMeta?.createdDateTime || '',
            transcriptStartDateTime: graphTranscriptMeta?.startDateTime || '',
            transcriptEndDateTime: graphTranscriptMeta?.endDateTime || '',
            participantEmails,
            vtt,
            text,
            ai: { status: 'none' },
          });
        } catch (e) {
          if (e.code === 11000) {
            doc = await Transcript.findOne({ orgId, eventId, transcriptId });
            if (!doc && (!eventId || graphTranscriptMeta)) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
          } else {
            throw e;
          }
        }
      }

      // Hard guard
      if (!doc) {
        return res.status(500).send('Transcript document could not be created or loaded.');
      }

      if (graphTranscriptMeta && !doc.transcriptCreatedDateTime) {
        await Transcript.updateOne({ _id: doc._id }, { $set: {
          transcriptCreatedDateTime: graphTranscriptMeta.createdDateTime || '',
          transcriptStartDateTime: graphTranscriptMeta.startDateTime || '',
          transcriptEndDateTime: graphTranscriptMeta.endDateTime || '',
        } });
        doc.transcriptCreatedDateTime = graphTranscriptMeta.createdDateTime || '';
        doc.transcriptStartDateTime = graphTranscriptMeta.startDateTime || '';
        doc.transcriptEndDateTime = graphTranscriptMeta.endDateTime || '';
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
      if (eventId) {
        const ref = transcriptRefFromDoc(doc);
        await EventCache.updateOne(
          { orgId, userEmail: me, eventId },
          { $set: { hasTranscript: true, transcripts: ref ? [ref] : [], syncedAt: new Date() } }
        ).catch(()=>{});
      }

      // If summary already done
      if (doc.ai?.status === 'done' && doc.ai?.summary) {
        try {
        const freshForActions = await Transcript.findById(doc._id);
        await upsertActionItemsForTranscript(freshForActions);
      } catch (actionErr) {
        console.warn('[actions] generation failed:', actionErr.message || String(actionErr));
      }

      return res.redirect(returnSummary ? `/user/transcript/saved/${doc._id}/summary` : `/user/transcript/saved/${doc._id}`);
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
            startDateTime: doc.startDateTime || '',
            endDateTime: doc.endDateTime || '',
            durationMinutes: v278MeetingDurationMinutes(doc),
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

      return res.redirect(returnSummary ? `/user/transcript/saved/${doc._id}/summary` : `/user/transcript/saved/${doc._id}`);
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
    fullBleed: true,
    user: req.user,
    org: req.user.org,
    doc,
  });
});


router.get('/transcript/saved/:id/download.txt', requireUser, async (req, res, next) => {
  try {
    const doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');
    const filename = `${v272SafeFilename(doc.subject || 'transcript')}-transcript.txt`;
    const body = [
      `Meeting: ${doc.subject || 'Meeting transcript'}`,
      doc.startDateTime ? `Date: ${v272DownloadDateLabel(doc.startDateTime)}` : '',
      '',
      'Transcript',
      '==========',
      '',
      String(doc.text || doc.vtt || 'No transcript text found in this saved record.'),
    ].filter(x => x !== '').join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(body);
  } catch (e) {
    if (e.status === 403) return res.status(403).send('Forbidden');
    return next(e);
  }
});

router.get('/transcript/saved/:id/email.eml', requireUser, async (req, res, next) => {
  try {
    const doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');
    const built = v280BuildTranscriptEmail(doc);
    res.setHeader('Content-Type', 'message/rfc822; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    return res.send(built.eml);
  } catch (e) {
    if (e.status === 403) return res.status(403).send('Forbidden');
    return next(e);
  }
});

router.get('/transcript/saved/:id/summary/download.txt', requireUser, async (req, res, next) => {
  try {
    let doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');
    doc = await v272EnsureSummaryForDoc(doc);
    const filename = `${v272SafeFilename(doc.subject || 'summary')}-ai-summary.txt`;
    const body = [
      `Meeting: ${doc.subject || 'Meeting summary'}`,
      doc.startDateTime ? `Date: ${v272DownloadDateLabel(doc.startDateTime)}` : '',
      '',
      'AI Summary',
      '==========',
      '',
      String(doc.ai?.summary || doc.ai?.error || 'No AI summary is available yet.'),
    ].filter(x => x !== '').join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(body);
  } catch (e) {
    if (e.status === 403) return res.status(403).send('Forbidden');
    return next(e);
  }
});

router.post('/transcript/saved/:id/reload', requireUser, ensureUserFreshToken, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');
  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();
  if (!accessToken) return res.status(401).send('No access token.');
  if (!doc.meetingId || !doc.transcriptId) return res.status(400).send('This transcript cannot be reloaded because meetingId/transcriptId is missing.');
  try {
    const vtt = await getTranscript(accessToken, doc.meetingId, doc.transcriptId, 'text/vtt');
    const text = vttToText(vtt);
    await Transcript.updateOne({ _id: doc._id }, { $set: {
      vtt,
      text,
      'ai.status': 'none',
      'ai.summary': '',
      'ai.error': '',
      'ai.updatedAt': new Date(),
      'ai.detailedStatus': 'none',
      'ai.detailedNotes': '',
      'ai.detailedError': '',
      'ai.detailedUpdatedAt': new Date(),
      reloadedAt: new Date(),
      reloadedByEmail: req.user.email,
    }});
    await TranscriptChunk.deleteMany({ orgId: req.user.org._id, transcriptDocId: doc._id });
    const fresh = await Transcript.findById(doc._id);
    await ensureTranscriptChunksForDoc(fresh);
    await writeAudit(req, 'TRANSCRIPT_RELOADED', 'Transcript', doc._id, `Reloaded latest transcript for ${doc.subject || doc._id}`);
    return res.redirect(`/user/transcript/saved/${doc._id}?reloaded=1`);
  } catch (e) {
    await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.status': 'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() } });
    return res.status(500).send(e.message || String(e));
  }
});


router.post('/transcript/saved/:id/summary/edit', requireUser, async (req, res, next) => {
  try {
    const doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');
    const summary = String(req.body.summary || '').trim();
    if (!summary) return res.status(400).send('Summary cannot be empty.');
    await Transcript.updateOne(
      { _id: doc._id },
      {
        $set: {
          'ai.summary': summary,
          'ai.status': 'done',
          'ai.editedAt': new Date(),
          'ai.editedByEmail': req.user.email,
          'ai.reviewed': true,
          'ai.reviewedAt': new Date(),
          'ai.reviewedByEmail': req.user.email,
          'ai.reviewNote': 'Edited by user',
          'ai.updatedAt': new Date(),
        },
      }
    );
    return res.redirect(`/user/transcript/saved/${doc._id}/summary?saved=1`);
  } catch (e) {
    if (e.status === 403) return res.status(403).send('Forbidden');
    return next(e);
  }
});

router.get('/transcript/saved/:id/summary', requireUser, async (req, res, next) => {
  try {
    let doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');

    // v27.2: the AI Summary button should be useful on its own. If the transcript
    // exists but summary has not been generated yet, generate it here and then render.
    // v31.4.2: regeneration is an admin-only control. Normal users can view/generate
    // a missing summary, but cannot force-replace an existing one via query string.
    const canRegenerateSummary = req.user.role === 'super_admin';
    const wantsRegenerate = String(req.query.regenerate || '') === '1';
    doc = await v272EnsureSummaryForDoc(doc, { force: wantsRegenerate && canRegenerateSummary });

    return res.render('user/summary', {
      title: 'AI Summary',
      fullBleed: true,
      user: req.user,
      org: req.user.org,
      doc,
      summarySections: v272SummarySections(doc.ai?.summary || ''),
      meetingDurationMinutes: v278MeetingDurationMinutes(doc),
      summaryLineCount: v278SummaryLineCount(doc),
      issueSubmitted: String(req.query.issue || '') === '1',
      reviewedSaved: String(req.query.reviewed || '') === '1',
      canRegenerateSummary,
    });
  } catch (e) {
    if (e.status === 403) return res.status(403).send('Forbidden');
    return next(e);
  }
});


// v30: MVP trust/review helpers
function v30IssueReturnUrl(req, fallback) {
  const raw = String(req.body.returnTo || req.query.returnTo || '').trim();
  if (raw && raw.startsWith('/')) return raw;
  return fallback || '/user/home';
}

router.post('/transcript/saved/:id/summary/review', requireUser, async (req, res, next) => {
  try {
    const doc = await v272LoadTranscriptForUser(req, req.params.id);
    if (!doc) return res.status(404).send('Transcript not found');
    const status = String(req.body.status || 'reviewed').trim() === 'needs_correction' ? 'needs_correction' : 'reviewed';
    await Transcript.updateOne({ _id: doc._id }, { $set: {
      'ai.reviewed': status === 'reviewed',
      'ai.reviewedAt': new Date(),
      'ai.reviewedByEmail': req.user.email,
      'ai.reviewNote': String(req.body.note || '').trim().slice(0, 1000),
      'ai.updatedAt': new Date(),
    }});
    await AuditLog.create({ orgId:req.user.org._id, actorEmail:req.user.email, action: status === 'reviewed' ? 'SUMMARY_REVIEWED' : 'SUMMARY_NEEDS_CORRECTION', entityType:'Transcript', entityId:String(doc._id), summary:`AI summary marked ${status.replace('_',' ')}` });
    return res.redirect(`/user/transcript/saved/${doc._id}/summary?reviewed=1`);
  } catch (e) { if (e.status === 403) return res.status(403).send('Forbidden'); return next(e); }
});

router.post('/intelligence-cache/:id/review', requireUser, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) return res.status(400).json({ ok:false, error:'Invalid intelligence id' });
    const status = String(req.body.status || 'reviewed').trim() === 'needs_correction' ? 'needs_correction' : 'reviewed';
    const cache = await IntelligenceCache.findOneAndUpdate(
      { _id:req.params.id, orgId:req.user.org._id, 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } },
      { $set: { review: { status, reviewedAt:new Date(), reviewedByEmail:req.user.email, note:String(req.body.note || '').trim().slice(0,1000) } } },
      { new:true }
    ).lean();
    if (!cache) return res.status(404).json({ ok:false, error:'Intelligence answer not found' });
    await AuditLog.create({ orgId:req.user.org._id, actorEmail:req.user.email, action: status === 'reviewed' ? 'INTELLIGENCE_REVIEWED' : 'INTELLIGENCE_NEEDS_CORRECTION', entityType:'IntelligenceCache', entityId:String(cache._id), summary:`Intelligence answer marked ${status.replace('_',' ')}` });
    return res.json({ ok:true, review: cache.review });
  } catch (e) { return next(e); }
});

router.post('/issues', requireUser, async (req, res, next) => {
  try {
    const targetType = ['summary','transcript','thread','thread_intelligence','meeting_prep','other'].includes(String(req.body.targetType || '')) ? String(req.body.targetType) : 'other';
    const issueType = ['wrong_transcript','wrong_meeting','bad_ai_summary','missing_transcript','bad_thread_intelligence','permission_issue','other'].includes(String(req.body.issueType || '')) ? String(req.body.issueType) : 'other';
    await IssueReport.create({
      orgId: req.user.org._id,
      reporterUserId: req.user._id,
      reporterEmail: req.user.email,
      reporterName: req.user.name || '',
      targetType,
      targetId: String(req.body.targetId || '').trim().slice(0, 160),
      targetTitle: String(req.body.targetTitle || '').trim().slice(0, 240),
      issueType,
      details: String(req.body.details || '').trim().slice(0, 3000),
      route: req.get('referer') || req.originalUrl || '',
      userAgent: req.get('user-agent') || '',
    });
    await AuditLog.create({ orgId:req.user.org._id, actorEmail:req.user.email, action:'ISSUE_REPORTED', entityType:'IssueReport', summary:`Reported ${issueType} on ${targetType}` });
    const ret = v30IssueReturnUrl(req, '/user/home');
    return res.redirect(ret + (ret.includes('?') ? '&' : '?') + 'issue=1');
  } catch (e) { return next(e); }
});

router.get('/transcript/saved/:id/notes', requireUser, (req, res) => {
  return res.redirect(`/user/transcript/saved/${req.params.id}/summary`);
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
  const thread = await MeetingThread.findOne({ _id: req.params.id, orgId: req.user.org._id, 'acl.allowedEmails': { $in: principals } });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can remove meetings.');
  await MeetingThread.updateOne({ _id: req.params.id, orgId: req.user.org._id }, { $pull: { meetingIds: meetingId }, $set: { updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_MEETING_REMOVED', 'MeetingThread', req.params.id, `Removed meeting ${meetingId}`);
  return res.redirect('/user/threads/' + req.params.id + '#diary-intelligence');
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


// v27.8: registered-user people search used by collaborator typeahead.
router.get('/people/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ ok: true, people: [] });
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const tenantId = String(req.user.o365?.tid || '').trim();
  const query = {
    org: req.user.org._id,
    status: { $ne: 'inactive' },
    $or: [{ name: rx }, { email: rx }, { 'principals.emails': rx }],
  };
  if (tenantId) {
    query.$and = [{ $or: [
      { 'o365.tid': tenantId },
      { 'o365.tid': { $in: ['', null] } },
      { 'o365.tid': { $exists: false } },
    ] }];
  }
  const users = await User.find(query)
    .select({ name:1, email:1, 'o365.tid':1 })
    .sort({ name:1, email:1 })
    .limit(20)
    .lean();
  const me = String(req.user.email || '').toLowerCase().trim();
  const people = users
    .filter(u => String(u.email || '').toLowerCase() !== me)
    .map(u => ({ name: u.name || u.email, email: u.email }));
  return res.json({ ok: true, people });
});




function parseCsvEmails(value) {
  return String(value || '').split(/[;,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
}
function uniqEmails(list) { return [...new Set((list || []).map(x => String(x||'').trim().toLowerCase()).filter(Boolean))]; }
function v279EntryType(rawKind, rawVisibility) {
  const key = String(rawKind || 'note').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = {
    note: { kind: 'note', visibility: 'thread', title: 'Note' },
    private_note: { kind: 'note', visibility: 'private', title: 'Personal note' },
    personal_note: { kind: 'note', visibility: 'private', title: 'Personal note' },
    follow_up: { kind: 'follow_up', visibility: 'thread', title: 'Follow-up' },
    followup: { kind: 'follow_up', visibility: 'thread', title: 'Follow-up' },
    discussion: { kind: 'discussion', visibility: 'thread', title: 'Discussion' },
    moms: { kind: 'moms', visibility: 'thread', title: 'MoMs' },
    mom: { kind: 'moms', visibility: 'thread', title: 'MoMs' },
    minutes: { kind: 'moms', visibility: 'thread', title: 'MoMs' },
    progress: { kind: 'progress', visibility: 'thread', title: 'Progress' },
    decision: { kind: 'decision', visibility: 'thread', title: 'Decision' },
    risk: { kind: 'risk', visibility: 'thread', title: 'Risk' },
    action: { kind: 'action', visibility: 'thread', title: 'Action' },
    status: { kind: 'status', visibility: 'thread', title: 'Status' },
  };
  const meta = map[key] || map.note;
  if (rawVisibility === 'private') return { ...meta, visibility: 'private', title: meta.title === 'Note' ? 'Personal note' : meta.title };
  return meta;
}
function v279CanManageThreadPeople(req, thread) {
  const principals = (getUserPrincipals(req.user) || []).map(x => String(x || '').toLowerCase());
  const people = uniqEmails([thread.ownerEmail, ...(thread.contributorEmails || []), ...(thread.memberEmails || []), ...(thread.acl?.allowedEmails || [])]);
  return people.some(e => principals.includes(String(e).toLowerCase()));
}
function formatThreadTime(d) {
  try { return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }); } catch(e) { return d || ''; }
}
function threadAccessQuery(req) {
  const principals = getUserPrincipals(req.user);
  return { orgId: req.user.org._id, deletedAt: null, $or: [{ 'acl.allowedEmails': { $in: principals } }, { ownerEmail: { $in: principals } }, { contributorEmails: { $in: principals } }, { viewerEmails: { $in: principals } }] };
}
function canOwnThread(req, thread) {
  const principals = getUserPrincipals(req.user).map(x => String(x).toLowerCase());
  return String(thread.ownerUserId || '') === String(req.user._id) || String(thread.createdBy || '') === String(req.user._id) || principals.includes(String(thread.ownerEmail || '').toLowerCase());
}
function normalizeThreadShape(thread) {
  if (!thread) return thread;
  thread.meetingIds = Array.isArray(thread.meetingIds) ? thread.meetingIds : [];
  thread.entries = Array.isArray(thread.entries) ? thread.entries : [];
  thread.links = Array.isArray(thread.links) ? thread.links : [];
  thread.contributorEmails = Array.isArray(thread.contributorEmails) ? thread.contributorEmails : [];
  thread.viewerEmails = Array.isArray(thread.viewerEmails) ? thread.viewerEmails : [];
  thread.memberEmails = Array.isArray(thread.memberEmails) ? thread.memberEmails : [];
  thread.acl = thread.acl || {};
  thread.acl.allowedEmails = Array.isArray(thread.acl.allowedEmails) ? thread.acl.allowedEmails : [];
  thread.ai = thread.ai || {};
  thread.recurringChain = thread.recurringChain || {};
  return thread;
}
function canContributeThread(req, thread) {
  thread = normalizeThreadShape(thread);
  const principals = getUserPrincipals(req.user).map(x => String(x).toLowerCase());
  if (canOwnThread(req, thread)) return true;
  if ((thread.contributorEmails || []).some(e => principals.includes(String(e).toLowerCase()))) return true;
  // Legacy threads created before contributor/viewer fields may only have ACL membership.
  // In that case, allow an accessible thread member to add meetings/context/health judgement.
  const hasModernRoles = (thread.contributorEmails || []).length || (thread.viewerEmails || []).length || (thread.memberEmails || []).length;
  if (!hasModernRoles && (thread.acl?.allowedEmails || []).some(e => principals.includes(String(e).toLowerCase()))) return true;
  return false;
}
function sourceForKind(kind) {
  return ({ call:'Call note', generated_note:'AI-generated note', meeting:'Manual meeting', decision:'Decision', risk:'Risk', action:'Action', note:'Manual note', status:'Manual note', follow_up:'Follow-up', discussion:'Discussion', moms:'MoMs', progress:'Progress' })[kind] || 'Manual note';
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
  const thread = normalizeThreadShape(await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id }).lean());
  if (!thread) return res.status(404).send('Thread not found');
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: req.user.org._id })
    .select({ _id:1, subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1 })
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
  const threadOptions = await MeetingThread.find({ orgId: req.user.org._id, deletedAt: null, $or: [{ 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }, { ownerEmail: String(req.user.email||'').toLowerCase() }, { createdBy: req.user._id }] }).select({ _id:1, name:1 }).sort({ updatedAt:-1 }).limit(120).lean();
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
  return res.render('user/thread_detail', { title: thread.name, activeNav: 'threads', user: req.user, org: req.user.org, thread, meetings, allMeetings, canOwner, canContrib, fmtTime: formatThreadTime, users, metrics, actionStats, threadOptions });
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

router.post('/threads/:id/entries/:entryId/delete', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can delete timeline items.');
  await MeetingThread.updateOne({ _id: thread._id }, { $pull: { entries: { _id: req.params.entryId } }, $set: { updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_ENTRY_DELETED', 'MeetingThread', thread._id, 'Deleted thread diary item');
  return res.redirect('/user/threads/' + thread._id + '#diary-intelligence');
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
  if (Object.prototype.hasOwnProperty.call(req.body, 'severity')) set['entries.$.severity'] = ['Low','Medium','High','Critical',''].includes(req.body.severity) ? req.body.severity : String(req.body.severity || '').trim();
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
    const insight = sanitizeExecutiveInsight(out.executiveMemory || out.progressSummary || '');
    const digest = digestFromThread(thread);
    await MeetingThread.updateOne({ _id: thread._id }, { $set: {
      'ai.status': 'done',
      'ai.model': out.model,
      'ai.insight': insight,
      'ai.insightGeneratedAt': new Date(),
      'ai.insightGeneratedBy': req.user._id,
      'ai.insightGeneratedByEmail': req.user.email,
      'ai.progressSummary': sanitizeExecutiveInsight(out.progressSummary || insight),
      'ai.executiveMemory': sanitizeExecutiveInsight(out.executiveMemory || insight),
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



router.post('/threads/:id/quick-insight', requireUser, meetingFileUpload.array('files', 8), async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can add quick insight.');
  const body = String(req.body.insight || req.body.body || '').trim();
  if (!body) return res.redirect('/user/threads/' + thread._id + '#diary');
  const entry = {
    kind: 'note',
    sourceType: 'Human insight',
    visibility: 'thread',
    title: String(req.body.title || 'Quick insight').trim() || 'Quick insight',
    body,
    occurredAt: new Date(),
    createdBy: req.user._id,
    createdByEmail: req.user.email,
    createdAt: new Date(),
    files: briefingFilesFromUpload(req.files),
  };
  await MeetingThread.updateOne({ _id: thread._id }, { $push: { entries: entry }, $set: { 'ai.insight': body, 'ai.insightEditedBy': req.user._id, 'ai.insightEditedByEmail': req.user.email, 'ai.insightEditedAt': new Date(), 'ai.updatedAt': new Date(), updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_QUICK_INSIGHT_ADDED', 'MeetingThread', thread._id, 'Added quick insight to diary');
  return res.redirect('/user/threads/' + thread._id + '#diary');
});

router.post('/threads/:id/links', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can add links.');
  let url = String(req.body.url || '').trim();
  if (!url) return res.redirect('/user/threads/' + thread._id);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const item = {
    title: String(req.body.title || '').trim() || url,
    url,
    description: String(req.body.description || '').trim(),
    category: String(req.body.category || 'Link').trim() || 'Link',
    createdBy: req.user._id,
    createdByEmail: req.user.email,
    createdAt: new Date(),
  };
  await MeetingThread.updateOne({ _id: thread._id }, { $push: { usefulLinks: item }, $set: { updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_LINK_ADDED', 'MeetingThread', thread._id, `Added link ${item.title}`);
  return res.redirect('/user/threads/' + thread._id + '#thread-links');
});

router.post('/threads/:id/links/:linkId/delete', requireUser, async (req, res) => {
  const thread = await MeetingThread.findOne({ ...threadAccessQuery(req), _id: req.params.id });
  if (!thread) return res.status(404).send('Thread not found');
  if (!canContributeThread(req, thread)) return res.status(403).send('Only owners and contributors can remove links.');
  await MeetingThread.updateOne({ _id: thread._id }, { $pull: { usefulLinks: { _id: req.params.linkId } }, $set: { updatedAt: new Date() } });
  await writeAudit(req, 'THREAD_LINK_REMOVED', 'MeetingThread', thread._id, 'Removed thread link');
  return res.redirect('/user/threads/' + thread._id + '#thread-links');
});

router.post('/briefings', requireUser, meetingFileUpload.array('files', 8), async (req, res) => {
  const toEmail = String(req.body.toEmail || '').trim().toLowerCase();
  if (!toEmail) return res.redirect(req.body.returnTo || '/user/home');
  const relatedRaw = []
    .concat(Array.isArray(req.body.relatedThreadIds) ? req.body.relatedThreadIds : [req.body.relatedThreadIds])
    .concat(Array.isArray(req.body.mentionThreadIds) ? req.body.mentionThreadIds : [req.body.mentionThreadIds])
    .filter(Boolean);
  const relatedIds = Array.from(new Set(relatedRaw.flatMap(x => String(x || '').split(',')).map(x => x.trim()).filter(Boolean))); 
  const relatedThreads = relatedIds.length ? await MeetingThread.find({ orgId: req.user.org._id, _id: { $in: relatedIds }, $or: [{ 'acl.allowedEmails': { $in: getUserPrincipals(req.user) } }, { ownerEmail: String(req.user.email||'').toLowerCase() }] }).select({ _id:1, name:1 }).lean() : [];
  const bodyText = String(req.body.body || '').trim();
  const actionItems = bodyText
    .split(/\n+/)
    .map(x => x.trim())
    .filter(x => /^#/.test(x))
    .map(x => ({
      text: (x.replace(/^#+\s*/, '').trim() || 'Briefing action request').slice(0, 220),
      status: 'Open',
      createdAt: new Date()
    }))
    .filter(x => x.text);
  const toUser = await User.findOne({ org: req.user.org._id, email: toEmail }).select({ name:1, email:1 }).lean();
  const briefing = await Briefing.create({
    orgId: req.user.org._id,
    fromUserId: req.user._id,
    fromEmail: req.user.email,
    fromName: req.user.name || req.user.email,
    toEmail,
    toName: toUser?.name || toEmail,
    title: String(req.body.title || '').trim(),
    body: bodyText,
    priority: ['Low','Medium','High','Critical'].includes(req.body.priority) ? req.body.priority : 'Medium',
    relatedThreadIds: relatedThreads.map(t => t._id),
    relatedThreadsSnapshot: relatedThreads.map(t => ({ threadId: String(t._id), name: t.name || 'Thread' })),
    files: briefingFilesFromUpload(req.files),
    actionItems,
    expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
  });
  // v25.4.2: turn # lines in briefings into real ActionItems assigned to the recipient.
  if (actionItems.length) {
    for (const a of actionItems) {
      const actionTitle = a.text && a.text !== 'Action Item' ? a.text : `Briefing action request - ${new Date().toISOString()}`;
      try {
        await ActionItem.create({
        orgId: req.user.org._id,
        // Give briefing-created actions a unique source id so the legacy unique index
        // { orgId, transcriptDocId, title } does not collide when transcriptDocId is null.
        transcriptDocId: new mongoose.Types.ObjectId(),
        eventId: `briefing:${briefing._id}`,
        meetingId: `briefing:${briefing._id}`,
        transcriptId: `briefing:${briefing._id}`,
        meetingSubject: briefing.title || 'Briefing',
        title: actionTitle,
        description: `Action requested in briefing${briefing.title ? ': ' + briefing.title : ''}.`,
        ownerName: toUser?.name || toEmail,
        ownerEmail: toEmail,
        assignedByUserId: req.user._id,
        assignedByEmail: req.user.email,
        source: 'manual',
        dueDate: 'Unclear',
        dueDateISO: null,
        priority: briefing.priority === 'Critical' ? 'High' : (briefing.priority === 'High' ? 'High' : 'Medium'),
        status: 'Open',
        evidence: bodyText,
        acl: { allowedEmails: [...new Set([toEmail, String(req.user.email || '').toLowerCase()].filter(Boolean))], updatedAt: new Date() },
        generatedByModel: 'briefing-hash-action-v25.4.3',
      });
      } catch (actionErr) {
        if (actionErr && actionErr.code === 11000) {
          console.warn('Skipped duplicate briefing action item', actionTitle);
        } else {
          throw actionErr;
        }
      }
    }
    await writeAudit(req, 'BRIEFING_ACTIONS_CREATED', 'Briefing', briefing._id, `${actionItems.length} action item(s) created from briefing for ${toEmail}`);
  }
  await writeAudit(req, 'BRIEFING_SENT', 'Briefing', briefing._id, `Briefing sent to ${toEmail}`);
  return res.redirect(req.body.returnTo || '/user/home');
});

router.post('/briefings/:id/dismiss', requireUser, async (req, res) => {
  await Briefing.updateOne({ _id: req.params.id, orgId: req.user.org._id, toEmail: String(req.user.email || '').toLowerCase() }, { $set: { status: 'dismissed', dismissedAt: new Date(), updatedAt: new Date() } });
  return res.redirect(req.body.returnTo || '/user/home');
});

router.post('/briefings/:id/end', requireUser, async (req, res) => {
  await Briefing.updateOne({ _id: req.params.id, orgId: req.user.org._id, fromEmail: String(req.user.email || '').toLowerCase() }, { $set: { status: 'ended', endedAt: new Date(), updatedAt: new Date() } });
  return res.redirect(req.body.returnTo || '/user/home');
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
