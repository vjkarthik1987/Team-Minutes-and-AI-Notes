// workers/transcriptSweep.worker.js
const User = require('../models/User');
const EventCache = require('../models/EventCache');
const Transcript = require('../models/Transcript');
const TranscriptChunk = require('../models/TranscriptChunk');
const ActionItem = require('../models/ActionItem');
const UserGraphToken = require('../models/UserGraphToken');
const UserSyncState = require('../models/UserSyncState');
const { getFreshAccessTokenForUser } = require('../utils/graphTokenStore');
const { getCalendarRange } = require('../utils/graph');
const { annotateEventsWithTranscripts, getTranscript } = require('../utils/transcripts');
const { vttToText } = require('../utils/vtt');
const { generateMeetingSummary, generateDetailedMeetingNotes, generateActionItems } = require('../utils/openaiSummary');
const { normalizeEmail, uniq, filterByAllowedDomains } = require('../utils/email');
const { chunkByChars, cleanText } = require('../utils/transcriptChunking');

let running = false;
let timer = null;

function toIsoZ(graphDateTime) {
  const dt = typeof graphDateTime === 'string' ? graphDateTime : (graphDateTime?.dateTime || '');
  if (!dt) return '';
  const s = String(dt).trim();
  if (/[zZ]$/.test(s) || /[+\-]\d\d:\d\d$/.test(s)) return s;
  return `${s}Z`;
}

function attendeeEmailsFromEvent(ev, org) {
  const emails = [];
  const orgEmail = ev?.organizer?.emailAddress?.address;
  if (orgEmail) emails.push(orgEmail);
  const atts = Array.isArray(ev?.attendees) ? ev.attendees : [];
  for (const a of atts) {
    const em = a?.emailAddress?.address;
    if (em) emails.push(em);
  }
  return uniq(filterByAllowedDomains(emails.map(normalizeEmail).filter(Boolean), org?.allowedDomains));
}

async function ensureChunks(doc) {
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


async function upsertActionItemsForTranscript(doc) {
  if (String(process.env.SWEEP_GENERATE_ACTION_ITEMS || 'true').toLowerCase() === 'false') return { skipped: 'disabled' };
  if (!process.env.OPENAI_API_KEY) return { skipped: 'missing_openai_key' };

  const existing = await ActionItem.findOne({ transcriptDocId: doc._id }).select({ _id: 1 }).lean();
  if (existing || doc.processingLock?.actionItemsGeneratedAt) return { skipped: 'already_generated' };

  // v16.4: avoid hammering OpenAI every sweep for the same transient server error.
  const failedAt = doc.processingLock?.actionItemsFailedAt ? new Date(doc.processingLock.actionItemsFailedAt) : null;
  const failureCount = Number(doc.processingLock?.actionItemsFailureCount || 0);
  const cooldownMinutes = Math.min(24 * 60, Math.max(15, Number(process.env.ACTION_ITEMS_RETRY_COOLDOWN_MINUTES || 120)) * Math.max(1, failureCount));
  if (failedAt && (Date.now() - failedAt.getTime()) < cooldownMinutes * 60 * 1000) {
    return { skipped: 'cooldown_after_failure', failureCount, retryAfterMinutes: cooldownMinutes };
  }

  let generated;
  try {
    generated = await generateActionItems({ text: doc.text, subject: doc.subject });
  } catch (e) {
    const msg = String(e.message || e || 'Action item generation failed').slice(0, 500);
    await Transcript.updateOne({ _id: doc._id }, {
      $set: { 'processingLock.actionItemsFailedAt': new Date(), 'processingLock.actionItemsLastError': msg },
      $inc: { 'processingLock.actionItemsFailureCount': 1 }
    });
    return { skipped: 'ai_failed', error: msg };
  }
  const { model, items } = generated;
  const safeItems = (Array.isArray(items) ? items : [])
    .filter(x => String(x?.title || x?.description || '').trim())
    .slice(0, 30);

  if (!safeItems.length) {
    await Transcript.updateOne({ _id: doc._id }, {
      $set: {
        'processingLock.actionItemsGeneratedAt': new Date(),
        'processingLock.actionItemsModel': model,
        'processingLock.actionItemsLastError': ''
      }
    });
    return { created: 0, model };
  }

  const allowedEmails = Array.isArray(doc.acl?.allowedEmails) ? doc.acl.allowedEmails : [];
  await ActionItem.bulkWrite(safeItems.map(item => {
    const title = String(item.title || item.description || 'Action item').trim().slice(0, 220);
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
            ownerName: String(item.ownerName || 'Unassigned').trim() || 'Unassigned',
            ownerEmail: String(item.ownerEmail || '').toLowerCase().trim(),
            dueDate: String(item.dueDate || 'Unclear').trim() || 'Unclear',
            priority: ['Low', 'Medium', 'High', 'Unclear'].includes(item.priority) ? item.priority : 'Unclear',
            confidence: Math.max(0, Math.min(1, Number(item.confidence || 0))),
            evidence: String(item.evidence || '').trim(),
            acl: { allowedEmails, updatedAt: new Date() },
            generatedByModel: model,
            generatedAt: new Date(),
          },
          $setOnInsert: { status: 'Open', createdAt: new Date() },
        },
        upsert: true,
      }
    };
  }), { ordered: false });
  await Transcript.updateOne({ _id: doc._id }, {
    $set: {
      'processingLock.actionItemsGeneratedAt': new Date(),
      'processingLock.actionItemsModel': model,
      'processingLock.actionItemsLastError': ''
    }
  });
  return { created: safeItems.length, model };
}

async function maybeGenerateAI(doc) {
  if (String(process.env.SWEEP_GENERATE_AI || 'true').toLowerCase() === 'false') return;
  if (!process.env.OPENAI_API_KEY) return;

  if (!doc.ai?.summary) {
    try {
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.status': 'queued' } });
      const { model, summary } = await generateMeetingSummary({ text: doc.text, subject: doc.subject });
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.status': 'done', 'ai.model': model, 'ai.summary': summary, 'ai.updatedAt': new Date() } });
    } catch (e) {
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.status': 'error', 'ai.error': e.message || String(e), 'ai.updatedAt': new Date() } });
    }
  }

  if (!doc.ai?.detailedNotes && String(process.env.SWEEP_GENERATE_DETAILED_NOTES || 'true').toLowerCase() === 'true') {
    try {
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.detailedStatus': 'queued' } });
      const { model, notes } = await generateDetailedMeetingNotes({ text: doc.text, subject: doc.subject });
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.detailedStatus': 'done', 'ai.detailedModel': model, 'ai.detailedNotes': notes, 'ai.detailedUpdatedAt': new Date() } });
    } catch (e) {
      await Transcript.updateOne({ _id: doc._id }, { $set: { 'ai.detailedStatus': 'error', 'ai.detailedError': e.message || String(e), 'ai.detailedUpdatedAt': new Date() } });
    }
  }

  const actionResult = await upsertActionItemsForTranscript(await Transcript.findById(doc._id));
  if (actionResult?.skipped === 'ai_failed') {
    console.warn('[transcript-sweep] action item generation deferred:', actionResult.error);
  }
}

async function processEventTranscript({ org, accessToken, ev, tr }) {
  const orgId = org._id;
  const eventId = String(ev.id || '');
  const meetingId = String(tr.meetingId || tr.onlineMeetingId || '');
  const transcriptId = String(tr.id || '');
  if (!eventId || !meetingId || !transcriptId) return { skipped: 'missing ids' };

  const participants = attendeeEmailsFromEvent(ev, org);

  let doc = await Transcript.findOne({ orgId, eventId, transcriptId });
  if (!doc) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });

  if (doc) {
    const mergedAcl = uniq([...(doc.acl?.allowedEmails || []), ...participants]);
    const mergedParticipants = uniq([...(doc.participantEmails || []), ...participants]);
    await Transcript.updateOne(
      { _id: doc._id },
      { $set: { participantEmails: mergedParticipants, 'acl.allowedEmails': mergedAcl, 'acl.updatedAt': new Date() } }
    );
    await ensureChunks(doc);
    await maybeGenerateAI(doc);
    return { skipped: 'exists', transcriptDocId: String(doc._id) };
  }

  const vtt = await getTranscript(accessToken, meetingId, transcriptId, 'text/vtt');
  const text = vttToText(vtt);

  doc = await Transcript.create({
    orgId,
    eventId,
    meetingId,
    transcriptId,
    subject: ev.subject || '',
    startDateTime: toIsoZ(ev.start),
    endDateTime: toIsoZ(ev.end),
    participantEmails: participants,
    vtt,
    text,
    acl: { allowedEmails: participants, updatedAt: new Date() },
  });

  await ensureChunks(doc);
  await maybeGenerateAI(doc);
  return { created: true, transcriptDocId: String(doc._id) };
}

async function sweepOnce() {
  if (running) return { skipped: 'already running' };
  running = true;
  const stats = { users: 0, events: 0, transcriptsCreated: 0, transcriptsExisting: 0, errors: 0 };
  try {
    const lookbackDays = Math.max(1, Number(process.env.TRANSCRIPT_SWEEP_LOOKBACK_DAYS || 30));
    const maxUsers = Math.max(1, Number(process.env.TRANSCRIPT_SWEEP_MAX_USERS || 100));
    const maxEvents = Math.max(10, Number(process.env.TRANSCRIPT_SWEEP_MAX_EVENTS_PER_USER || 120));

    const tokenDocs = await UserGraphToken.find({ refreshToken: { $ne: '' } }).sort({ updatedAt: -1 }).limit(maxUsers).lean();
    for (const tokenDoc of tokenDocs) {
      const user = await User.findById(tokenDoc.user).populate('org');
      if (!user || user.status !== 'active' || !user.org) continue;
      const org = user.org;
      stats.users++;
      try {
        await UserSyncState.updateOne(
          { orgId: org._id, userEmail: normalizeEmail(user.email) },
          { $set: { lastSyncStartedAt: new Date(), lastSyncStatus: 'running', lastSyncError: '' }, $setOnInsert: { orgId: org._id, userEmail: normalizeEmail(user.email) } },
          { upsert: true }
        );
        const accessToken = await getFreshAccessTokenForUser(user._id);
        const now = new Date();
        const start = new Date(now); start.setDate(now.getDate() - lookbackDays); start.setHours(0,0,0,0);
        const end = new Date(now); end.setHours(23,59,59,999);
        const list = await getCalendarRange(accessToken, { startDateTime: start.toISOString(), endDateTime: end.toISOString(), top: 75, max: maxEvents });
        const candidates = (Array.isArray(list) ? list : []).filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));
        const annotated = await annotateEventsWithTranscripts(accessToken, candidates, { maxChecks: maxEvents, concurrency: 3 });
        const transcriptEvents = (annotated || []).filter(ev => ev._hasTranscript && ev._transcripts?.length);

        for (const ev of transcriptEvents) {
          stats.events++;
          const participants = attendeeEmailsFromEvent(ev, org);
          const me = normalizeEmail(user.email);
          await EventCache.updateOne(
            { orgId: org._id, userEmail: me, eventId: String(ev.id) },
            { $set: {
              orgId: org._id,
              userEmail: me,
              eventId: String(ev.id),
              subject: ev.subject || '',
              startDateTime: toIsoZ(ev.start),
              endDateTime: toIsoZ(ev.end),
              location: ev.location?.displayName || '',
              organizerEmail: normalizeEmail(ev.organizer?.emailAddress?.address || ''),
              attendeeEmails: participants,
              hasTranscript: true,
              transcripts: (ev._transcripts || []).map(t => ({ meetingId: String(t.meetingId || ''), transcriptId: String(t.id || '') })),
              syncedAt: new Date(),
            }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
          );
          for (const tr of ev._transcripts) {
            const r = await processEventTranscript({ org, accessToken, ev, tr });
            if (r.created) stats.transcriptsCreated++;
            if (r.skipped === 'exists') stats.transcriptsExisting++;
          }
        }
        await UserSyncState.updateOne(
          { orgId: org._id, userEmail: normalizeEmail(user.email) },
          { $set: { lastSyncedAt: new Date(), lastTranscriptAiLoadAt: new Date(), lastSyncStatus: 'done', lastSyncStats: stats, lastSyncError: '' } },
          { upsert: true }
        );
      } catch (e) {
        stats.errors++;
        console.warn('[transcript-sweep] user failed:', user.email, e.message || String(e));
        await UserGraphToken.updateOne({ user: user._id }, { $set: { lastError: e.message || String(e) } });
        await UserSyncState.updateOne(
          { orgId: org._id, userEmail: normalizeEmail(user.email) },
          { $set: { lastSyncedAt: new Date(), lastSyncStatus: 'error', lastSyncError: e.message || String(e) } },
          { upsert: true }
        );
      }
    }
    console.log('[transcript-sweep] complete', stats);
    return stats;
  } finally {
    running = false;
  }
}

function startTranscriptSweepScheduler() {
  const enabled = String(process.env.ENABLE_TRANSCRIPT_SWEEP || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[transcript-sweep] disabled');
    return;
  }
  const everyHours = Math.max(1, Number(process.env.TRANSCRIPT_SWEEP_EVERY_HOURS || 2));
  const intervalMs = everyHours * 60 * 60 * 1000;
  const runOnStart = String(process.env.TRANSCRIPT_SWEEP_RUN_ON_START || 'true').toLowerCase() !== 'false';

  if (runOnStart) setTimeout(() => sweepOnce().catch(e => console.warn('[transcript-sweep] failed:', e.message || String(e))), 15000);
  timer = setInterval(() => sweepOnce().catch(e => console.warn('[transcript-sweep] failed:', e.message || String(e))), intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[transcript-sweep] scheduled every ${everyHours} hour(s)`);
}

module.exports = { sweepOnce, startTranscriptSweepScheduler };
