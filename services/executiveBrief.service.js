const ExecutiveBrief = require('../models/ExecutiveBrief');
const ActionItem = require('../models/ActionItem');
const EventCache = require('../models/EventCache');
const MeetingThread = require('../models/MeetingThread');
const Transcript = require('../models/Transcript');
const DecisionItem = require('../models/DecisionItem');
const RiskSignal = require('../models/RiskSignal');
const ThreadScore = require('../models/ThreadScore');
const { getUserPrincipals } = require('../utils/acl');

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d = new Date()) { const x = new Date(d); x.setHours(23,59,59,999); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function briefDate(d = new Date()) { return startOfDay(d).toISOString().slice(0,10); }
function escText(s, n = 220) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }
function confidence(n) { return Math.max(0.35, Math.min(0.95, Number(n || 0.6))); }
function actionScope(user) {
  const email = String(user.email || '').toLowerCase();
  return { $or: [{ ownerEmail: email }, { 'acl.allowedEmails': email }, { assignedByUserId: user._id }] };
}
function item({ title, summary, why, suggestedNextStep, urgency = 'Medium', confidence: c = 0.6, ownerName = '', ownerEmail = '', sourceType = '', sourceId = '', sourceTitle = '', sourceDate = null }) {
  return { title: escText(title, 140), summary: escText(summary, 360), why: escText(why, 360), suggestedNextStep: escText(suggestedNextStep, 260), urgency, confidence: confidence(c), ownerName, ownerEmail, sourceType, sourceId: String(sourceId || ''), sourceTitle: escText(sourceTitle, 180), sourceDate };
}
function isDecisionText(s) { return /\b(decision|decide|approval|approve|sign[- ]?off|finalize|choose|go\/no-go|pending)\b/i.test(String(s || '')); }
function isRiskText(s) { return /\b(risk|blocked|blocker|delay|slip|concern|issue|escalat|dependency|stuck|waiting|missed|overdue)\b/i.test(String(s || '')); }
function formatBriefAsMarkdown(brief) {
  const lines = [];
  lines.push(`# Today's Executive Brief`);
  lines.push('');
  lines.push(brief.executiveSummary || brief.headline || 'No major signals yet.');
  const sections = [
    ['Top 5 focus areas', brief.focusAreas], ['Silent risks', brief.silentRisks], ['People to follow up', brief.followUps],
    ['Meetings that matter', brief.importantMeetings], ['Threads slipping', brief.slippingThreads], ['Decisions pending', brief.pendingDecisions], ['Stale actions', brief.staleActions]
  ];
  for (const [name, arr] of sections) {
    lines.push('', `## ${name}`);
    if (!arr || !arr.length) { lines.push('- Nothing material detected.'); continue; }
    arr.forEach((x) => lines.push(`- **${x.title}** — ${x.summary}${x.suggestedNextStep ? ` Next: ${x.suggestedNextStep}` : ''}`));
  }
  return lines.join('\n');
}

async function computeThreadScores({ orgId, user }) {
  const principals = getUserPrincipals(user);
  const threads = await MeetingThread.find({ orgId, deletedAt: null, $or: [{ ownerEmail: user.email }, { memberEmails: { $in: principals } }, { contributorEmails: { $in: principals } }, { viewerEmails: { $in: principals } }, { 'acl.allowedEmails': { $in: principals } }] }).sort({ updatedAt: -1 }).limit(80).lean();
  const scores = [];
  for (const t of threads) {
    const unresolved = (t.entries || []).filter(e => e.kind === 'action' && !/done|closed|dropped/i.test(e.status || '')).length;
    const risks = (t.entries || []).filter(e => e.kind === 'risk' || isRiskText(`${e.title} ${e.body}`)).length;
    const decisions = (t.entries || []).filter(e => e.kind === 'decision' || isDecisionText(`${e.title} ${e.body}`)).length;
    const last = t.updatedAt || t.createdAt;
    const inactiveDays = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : 0;
    let score = 85 - unresolved * 6 - risks * 10 - Math.min(inactiveDays, 21) - decisions * 3;
    let label = score < 35 ? 'Critical' : score < 55 ? 'Slipping' : score < 75 ? 'Attention Needed' : 'Healthy';
    const reason = [unresolved ? `${unresolved} unresolved action(s)` : '', risks ? `${risks} risk/blocker signal(s)` : '', inactiveDays > 7 ? `${inactiveDays} days without activity` : '', decisions ? `${decisions} decision signal(s)` : ''].filter(Boolean).join(' · ') || 'No major negative signals detected.';
    const doc = await ThreadScore.findOneAndUpdate({ orgId, threadId: t._id }, { healthScore: Math.max(5, Math.round(score)), healthLabel: label, reason, unresolvedActions: unresolved, overdueActions: 0, lastActivityAt: last || null, computedAt: new Date() }, { upsert: true, new: true });
    scores.push({ thread: t, score: doc.toObject ? doc.toObject() : doc });
  }
  return scores;
}

async function generateExecutiveBriefForUser({ user, date = new Date(), force = false }) {
  const orgId = user.org?._id || user.org;
  const email = String(user.email || '').toLowerCase();
  const dateKey = briefDate(date);
  if (!force) {
    const existing = await ExecutiveBrief.findOne({ orgId, userEmail: email, scope: 'personal', briefDate: dateKey }).lean();
    if (existing) return existing;
  }
  const todayStart = startOfDay(date), todayEnd = endOfDay(date);
  const nextWeek = endOfDay(addDays(date, 7));
  const principals = getUserPrincipals(user);
  const [todayMeetings, upcomingMeetings, openActions, overdueActions, recentTranscripts, pendingDecisions, openRisks] = await Promise.all([
    EventCache.find({ orgId, userEmail: email, startDateTime: { $gte: todayStart.toISOString(), $lte: todayEnd.toISOString() } }).sort({ startDateTime: 1 }).limit(25).lean(),
    EventCache.find({ orgId, userEmail: email, startDateTime: { $gte: todayStart.toISOString(), $lte: nextWeek.toISOString() } }).sort({ startDateTime: 1 }).limit(40).lean(),
    ActionItem.find({ orgId, status: { $nin: ['Done','Dropped'] }, ...actionScope(user) }).sort({ dueDateISO: 1, updatedAt: -1 }).limit(60).lean(),
    ActionItem.find({ orgId, status: { $nin: ['Done','Dropped'] }, dueDateISO: { $lt: new Date() }, ...actionScope(user) }).sort({ dueDateISO: 1 }).limit(30).lean(),
    Transcript.find({ orgId, 'acl.allowedEmails': { $in: principals } }).select({ subject:1, startDateTime:1, 'ai.summary':1, 'ai.detailedNotes':1, 'ai.actions':1, 'ai.decisions':1, 'ai.risks':1 }).sort({ startDateTime:-1 }).limit(60).lean(),
    DecisionItem.find({ orgId, userEmail: email, status: 'pending' }).sort({ updatedAt: -1 }).limit(20).lean(),
    RiskSignal.find({ orgId, userEmail: email, status: 'open' }).sort({ severity: -1, detectedAt: -1 }).limit(20).lean(),
  ]);
  const threadScores = await computeThreadScores({ orgId, user });
  const slipping = threadScores.filter(x => ['Slipping','Critical','Attention Needed'].includes(x.score.healthLabel)).sort((a,b) => a.score.healthScore - b.score.healthScore).slice(0,8);

  const focusAreas = [];
  overdueActions.slice(0, 3).forEach(a => focusAreas.push(item({ title: a.title, summary: `${a.ownerName || a.ownerEmail || 'Owner'} has an overdue action from ${a.meetingSubject || 'general context'}.`, why: 'Overdue action with visible ownership is a direct execution risk.', suggestedNextStep: `Follow up with ${a.ownerName || a.ownerEmail || 'the owner'} and confirm latest ETA.`, urgency: 'High', confidence: 0.82, ownerName: a.ownerName, ownerEmail: a.ownerEmail, sourceType: 'Action', sourceId: a._id, sourceTitle: a.meetingSubject, sourceDate: a.dueDateISO || a.updatedAt })));
  slipping.slice(0, 2).forEach(x => focusAreas.push(item({ title: x.thread.name, summary: x.score.reason, why: `Thread health is ${x.score.healthLabel}.`, suggestedNextStep: 'Open the thread and close ownership, decisions, or blockers.', urgency: x.score.healthLabel === 'Critical' ? 'Critical' : 'High', confidence: 0.78, ownerEmail: x.thread.ownerEmail, sourceType: 'Thread', sourceId: x.thread._id, sourceTitle: x.thread.name, sourceDate: x.thread.updatedAt })));
  if (focusAreas.length < 5) todayMeetings.slice(0, 5 - focusAreas.length).forEach(m => focusAreas.push(item({ title: m.subject || 'Meeting today', summary: 'Meeting appears on today’s calendar and may need preparation.', why: 'Today’s meeting with possible continuity context.', suggestedNextStep: 'Review previous notes before joining.', urgency: 'Medium', confidence: 0.55, sourceType: 'Meeting', sourceId: m.eventId, sourceTitle: m.subject, sourceDate: m.startDateTime ? new Date(m.startDateTime) : null })));

  const silentRisks = [];
  openRisks.slice(0, 4).forEach(r => silentRisks.push(item({ title: r.title, summary: r.summary, why: 'Previously detected risk signal remains open.', suggestedNextStep: 'Assign an owner or mark resolved if stale.', urgency: r.severity || 'Medium', confidence: r.confidence || 0.65, sourceType: r.sourceType || 'Risk', sourceId: r.sourceId, sourceTitle: r.sourceTitle, sourceDate: r.detectedAt })));
  recentTranscripts.filter(t => isRiskText(`${t.ai?.summary || ''} ${t.ai?.detailedNotes || ''} ${JSON.stringify(t.ai?.risks || '')}`)).slice(0, 4 - silentRisks.length).forEach(t => silentRisks.push(item({ title: t.subject || 'Risk signal from meeting', summary: escText(t.ai?.summary || t.ai?.detailedNotes || 'Risk-like language was detected in this meeting.'), why: 'Recent meeting contains blocker/risk/delay language.', suggestedNextStep: 'Review this meeting and create/confirm an owner.', urgency: 'Medium', confidence: 0.6, sourceType: 'Transcript', sourceId: t._id, sourceTitle: t.subject, sourceDate: t.startDateTime ? new Date(t.startDateTime) : null })));

  const byOwner = new Map();
  openActions.forEach(a => { const k = a.ownerEmail || a.ownerName || 'Unassigned'; if (!byOwner.has(k)) byOwner.set(k, []); byOwner.get(k).push(a); });
  const followUps = [...byOwner.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 6).map(([k, list]) => item({ title: k, summary: `${list.length} open action(s), ${list.filter(a => a.dueDateISO && new Date(a.dueDateISO) < new Date()).length} overdue.`, why: 'Person has active ownership load or overdue items.', suggestedNextStep: `Ask for status on: ${escText(list[0]?.title, 100)}`, urgency: list.some(a => a.dueDateISO && new Date(a.dueDateISO) < new Date()) ? 'High' : 'Medium', confidence: 0.75, ownerName: list[0]?.ownerName, ownerEmail: list[0]?.ownerEmail, sourceType: 'Action', sourceId: list[0]?._id, sourceTitle: list[0]?.meetingSubject, sourceDate: list[0]?.updatedAt }));

  const importantMeetings = upcomingMeetings.slice(0, 8).map(m => item({ title: m.subject || 'Upcoming meeting', summary: m.startDateTime ? `Scheduled for ${new Date(m.startDateTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.` : 'Upcoming meeting.', why: /exec|steer|review|decision|client|delivery|risk|weekly|monthly|governance/i.test(m.subject || '') ? 'Title suggests executive/decision/continuity relevance.' : 'Upcoming meeting in the next week.', suggestedNextStep: 'Open preparation context before the meeting.', urgency: /exec|client|risk|decision|steer/i.test(m.subject || '') ? 'High' : 'Medium', confidence: 0.55, sourceType: 'Meeting', sourceId: m.eventId, sourceTitle: m.subject, sourceDate: m.startDateTime ? new Date(m.startDateTime) : null }));

  const slippingThreads = slipping.map(x => item({ title: x.thread.name, summary: x.score.reason, why: `Thread score ${x.score.healthScore}/100; label: ${x.score.healthLabel}.`, suggestedNextStep: 'Review unresolved entries and confirm the next decision/action.', urgency: x.score.healthLabel === 'Critical' ? 'Critical' : x.score.healthLabel === 'Slipping' ? 'High' : 'Medium', confidence: 0.78, ownerEmail: x.thread.ownerEmail, sourceType: 'Thread', sourceId: x.thread._id, sourceTitle: x.thread.name, sourceDate: x.score.lastActivityAt || x.thread.updatedAt }));

  const decisionSignals = pendingDecisions.map(d => item({ title: d.title, summary: d.summary, why: 'Decision registry item is still pending.', suggestedNextStep: 'Clarify approver and target decision date.', urgency: 'High', confidence: d.confidence || 0.62, ownerName: d.ownerName, ownerEmail: d.ownerEmail, sourceType: d.sourceType || 'Decision', sourceId: d.sourceId || d._id, sourceTitle: d.sourceTitle, sourceDate: d.updatedAt }));
  recentTranscripts.filter(t => isDecisionText(`${t.ai?.summary || ''} ${t.ai?.detailedNotes || ''} ${JSON.stringify(t.ai?.decisions || '')}`)).slice(0, Math.max(0, 6 - decisionSignals.length)).forEach(t => decisionSignals.push(item({ title: t.subject || 'Decision signal', summary: escText(t.ai?.summary || t.ai?.detailedNotes || 'Decision-like language detected.'), why: 'Recent meeting contains approval/decision language.', suggestedNextStep: 'Confirm whether a decision is still pending.', urgency: 'Medium', confidence: 0.56, sourceType: 'Transcript', sourceId: t._id, sourceTitle: t.subject, sourceDate: t.startDateTime ? new Date(t.startDateTime) : null })));

  const staleActions = openActions.filter(a => a.updatedAt && (Date.now() - new Date(a.updatedAt).getTime()) > 5 * 86400000).slice(0, 8).map(a => item({ title: a.title, summary: `No visible update since ${new Date(a.updatedAt).toLocaleDateString('en-IN')}.`, why: 'Open item appears stale.', suggestedNextStep: 'Ask owner for progress or mark Waiting/Done/Dropped.', urgency: a.dueDateISO && new Date(a.dueDateISO) < new Date() ? 'High' : 'Medium', confidence: 0.72, ownerName: a.ownerName, ownerEmail: a.ownerEmail, sourceType: 'Action', sourceId: a._id, sourceTitle: a.meetingSubject, sourceDate: a.updatedAt }));

  const headline = focusAreas.length ? `${focusAreas.length} priority signal(s), ${overdueActions.length} overdue action(s), ${slipping.length} thread(s) needing attention.` : 'No major execution risks detected today.';
  const executiveSummary = `Today has ${todayMeetings.length} meeting(s), ${openActions.length} open action(s), ${overdueActions.length} overdue action(s), and ${slipping.length} thread(s) that may need leadership attention.`;
  const payload = { orgId, userId: user._id, userEmail: email, scope: 'personal', briefDate: dateKey, status: 'generated', generatedAt: new Date(), generatedBy: 'heuristic-v20', headline, executiveSummary, focusAreas: focusAreas.slice(0,5), silentRisks: silentRisks.slice(0,6), followUps: followUps.slice(0,8), importantMeetings: importantMeetings.slice(0,8), slippingThreads: slippingThreads.slice(0,8), pendingDecisions: decisionSignals.slice(0,8), staleActions: staleActions.slice(0,8), stats: { meetingsToday: todayMeetings.length, openActions: openActions.length, overdueActions: overdueActions.length, slippingThreads: slipping.length, pendingDecisions: decisionSignals.length }, rawSignals: { generatedFor: email } };
  const doc = await ExecutiveBrief.findOneAndUpdate({ orgId, userEmail: email, scope: 'personal', briefDate: dateKey }, payload, { upsert: true, new: true, setDefaultsOnInsert: true });
  return doc.toObject ? doc.toObject() : doc;
}

module.exports = { generateExecutiveBriefForUser, computeThreadScores, formatBriefAsMarkdown, briefDate };
