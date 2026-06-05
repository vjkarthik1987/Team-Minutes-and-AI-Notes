const MeetingThread = require('../models/MeetingThread');
const Transcript = require('../models/Transcript');
const { generateThreadProgressSummary } = require('../utils/openaiSummary');

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

async function refreshOneThread(thread) {
  const meetings = await Transcript.find({ _id: { $in: thread.meetingIds || [] }, orgId: thread.orgId })
    .select({ subject:1, startDateTime:1, text:1, 'ai.summary':1, 'ai.detailedNotes':1 })
    .sort({ startDateTime:1 }).lean();
  const digest = digestFromThread(thread);
  const set = {
    'dailyDigest.whatChanged': digest.whatChanged,
    'dailyDigest.openRisks': digest.openRisks,
    'dailyDigest.overdueActions': digest.overdueActions,
    'dailyDigest.attentionToday': digest.attentionToday,
    'dailyDigest.updatedAt': new Date(),
  };
  if ((meetings.length || (thread.entries||[]).length) && process.env.OPENAI_API_KEY) {
    try {
      const out = await generateThreadProgressSummary({ meetings, threadName: thread.name, objective: thread.objective, desiredOutcome: '', status: thread.status, entries: thread.entries || [] });
      Object.assign(set, { 'ai.status':'done', 'ai.model':out.model, 'ai.progressSummary':out.progressSummary, 'ai.executiveMemory':out.executiveMemory || out.progressSummary, 'ai.healthScore':out.healthScore || 0, 'ai.healthLabel':out.healthLabel || '', 'ai.suggestedStatus':out.suggestedStatus || '', 'ai.error':'', 'ai.lastAnalyzedAt':new Date(), 'ai.updatedAt':new Date() });
    } catch(e) { Object.assign(set, { 'ai.status':'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() }); }
  }
  await MeetingThread.updateOne({ _id: thread._id }, { $set: set });
}

async function refreshAllThreads() {
  const active = await MeetingThread.find({ status: { $ne: 'Closed' } }).limit(Number(process.env.THREAD_DIGEST_MAX_THREADS || 200)).lean();
  for (const t of active) await refreshOneThread(t);
  return active.length;
}

function startThreadDigestScheduler() {
  if (process.env.DISABLE_THREAD_DIGEST_JOB === 'true') return;
  let lastKey = '';
  setInterval(async () => {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }));
    const key = ist.toISOString().slice(0,10);
    if (ist.getHours() === 6 && ist.getMinutes() < 10 && lastKey !== key) {
      lastKey = key;
      try { const count = await refreshAllThreads(); console.log(`[v16] Refreshed ${count} thread summaries/digests at 6 AM IST`); } catch(e) { console.error('[v16] Thread digest refresh failed', e); }
    }
  }, 5 * 60 * 1000);
}

module.exports = { startThreadDigestScheduler, refreshAllThreads, refreshOneThread };
