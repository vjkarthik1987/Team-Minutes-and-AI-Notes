const User = require('../models/User');
const ActionItem = require('../models/ActionItem');
const MeetingThread = require('../models/MeetingThread');
const PersonAlias = require('../models/PersonAlias');
const PersonSignal = require('../models/PersonSignal');

function normEmail(v) { return String(v || '').toLowerCase().trim(); }
function uniq(arr) { return [...new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean))]; }
function displayNameFromEmail(email) { return String(email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

async function buildPeopleDirectory(orgId) {
  const users = await User.find({ org: orgId }).select({ name: 1, email: 1, role: 1, status: 1 }).sort({ name: 1, email: 1 }).lean();
  const actions = await ActionItem.find({ orgId }).select({ ownerEmail: 1, ownerName: 1, status: 1, dueDateISO: 1, escalated: 1, updatedAt: 1, title: 1 }).lean();
  const threads = await MeetingThread.find({ orgId, deletedAt: null }).select({ name: 1, ownerEmail: 1, contributorEmails: 1, viewerEmails: 1, status: 1, priority: 1, updatedAt: 1 }).lean();
  const aliases = await PersonAlias.find({ orgId }).sort({ canonicalEmail: 1, alias: 1 }).lean();
  const now = Date.now();
  const map = new Map();
  function ensure(email, name) {
    email = normEmail(email);
    if (!email) return null;
    if (!map.has(email)) map.set(email, { email, name: name || displayNameFromEmail(email), roles: [], aliases: [], ownedThreads: [], contributingThreads: [], openActions: 0, waitingActions: 0, overdueActions: 0, escalatedActions: 0, staleActions: 0, doneActions: 0, signals: [] });
    const p = map.get(email); if (name && (!p.name || p.name === displayNameFromEmail(email))) p.name = name;
    return p;
  }
  users.forEach(u => { const p = ensure(u.email, u.name); if (p) p.roles.push(u.role || 'user'); });
  threads.forEach(t => {
    const owner = ensure(t.ownerEmail); if (owner) owner.ownedThreads.push({ id: t._id, name: t.name, status: t.status, priority: t.priority });
    (t.contributorEmails || []).forEach(e => { const p = ensure(e); if (p) p.contributingThreads.push({ id: t._id, name: t.name, status: t.status }); });
  });
  actions.forEach(a => {
    const p = ensure(a.ownerEmail, a.ownerName); if (!p) return;
    if (a.status === 'Done') p.doneActions += 1;
    if (['Open','In Progress','Waiting'].includes(a.status)) p.openActions += 1;
    if (a.status === 'Waiting') p.waitingActions += 1;
    if (a.escalated) p.escalatedActions += 1;
    if (a.dueDateISO && new Date(a.dueDateISO).getTime() < now && !['Done','Dropped'].includes(a.status)) p.overdueActions += 1;
    if (a.updatedAt && now - new Date(a.updatedAt).getTime() > 5*24*60*60*1000 && !['Done','Dropped'].includes(a.status)) p.staleActions += 1;
  });
  aliases.forEach(a => { const p = ensure(a.canonicalEmail, a.canonicalName); if (p) p.aliases.push(a.alias); });
  const signals = await PersonSignal.find({ orgId }).sort({ detectedAt: -1 }).limit(300).lean();
  signals.forEach(s => { const p = ensure(s.personEmail, s.personName); if (p && p.signals.length < 8) p.signals.push(s); });
  return [...map.values()].map(p => ({ ...p, roles: uniq(p.roles), aliases: uniq(p.aliases), loadScore: (p.openActions * 2) + (p.waitingActions * 3) + (p.overdueActions * 4) + (p.escalatedActions * 5) + p.ownedThreads.length })).sort((a,b)=>b.loadScore-a.loadScore || a.name.localeCompare(b.name));
}

async function refreshPersonSignals(orgId) {
  const actions = await ActionItem.find({ orgId }).select({ _id:1, title:1, ownerEmail:1, ownerName:1, status:1, dueDateISO:1, updatedAt:1, escalated:1, escalationNote:1, transcriptDocId:1 }).lean();
  const threads = await MeetingThread.find({ orgId, deletedAt: null }).select({ _id:1, name:1, ownerEmail:1, contributorEmails:1, status:1 }).lean();
  const now = Date.now();
  const docs = [];
  for (const a of actions) {
    const email = normEmail(a.ownerEmail); if (!email || ['Done','Dropped'].includes(a.status)) continue;
    if (a.dueDateISO && new Date(a.dueDateISO).getTime() < now) docs.push({ orgId, personEmail: email, personName: a.ownerName || displayNameFromEmail(email), signalType: 'followup', title: `Overdue action: ${a.title}`, detail: `Due date passed. Status is ${a.status}.`, severity: 'High', actionId: a._id, sourceType: 'ActionItem', sourceId: String(a._id) });
    if (a.status === 'Waiting') docs.push({ orgId, personEmail: email, personName: a.ownerName || displayNameFromEmail(email), signalType: 'blocker', title: `Waiting action: ${a.title}`, detail: a.escalationNote || 'Action is marked Waiting.', severity: 'Medium', actionId: a._id, sourceType: 'ActionItem', sourceId: String(a._id) });
    if (a.escalated) docs.push({ orgId, personEmail: email, personName: a.ownerName || displayNameFromEmail(email), signalType: 'blocker', title: `Escalated action: ${a.title}`, detail: a.escalationNote || 'Escalated without note.', severity: 'Critical', actionId: a._id, sourceType: 'ActionItem', sourceId: String(a._id) });
  }
  for (const t of threads) {
    const email = normEmail(t.ownerEmail); if (email) docs.push({ orgId, personEmail: email, signalType: 'ownership', title: `Owns thread: ${t.name}`, detail: `Thread status: ${t.status || 'Active'}`, severity: t.status === 'Blocked' ? 'High' : 'Low', threadId: t._id, sourceType: 'MeetingThread', sourceId: String(t._id) });
    (t.contributorEmails || []).forEach(e => { const ce = normEmail(e); if (ce) docs.push({ orgId, personEmail: ce, signalType: 'collaboration', title: `Collaborates on: ${t.name}`, detail: `Thread status: ${t.status || 'Active'}`, severity: 'Low', threadId: t._id, sourceType: 'MeetingThread', sourceId: String(t._id) }); });
  }
  await PersonSignal.deleteMany({ orgId });
  if (docs.length) await PersonSignal.insertMany(docs.slice(0, 500), { ordered: false });
  return docs.length;
}

module.exports = { buildPeopleDirectory, refreshPersonSignals };
