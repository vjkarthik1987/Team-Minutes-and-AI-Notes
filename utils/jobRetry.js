const EventCache = require('../models/EventCache');
const Transcript = require('../models/Transcript');
const TranscriptChunk = require('../models/TranscriptChunk');
const UserSyncState = require('../models/UserSyncState');

async function resetFailedTranscriptJobs({ orgId, userEmail = '', limit = 100 }) {
  const me = String(userEmail || '').toLowerCase().trim();
  const eventQuery = {
    orgId,
    hasTranscript: true,
    $or: [
      { aiIndexStatus: 'failed' },
      { aiIndexError: { $exists: true, $nin: ['', null] } },
      { aiIndexStatus: 'processing' },
    ],
  };
  if (me) eventQuery.userEmail = me;

  const events = await EventCache.find(eventQuery).select({ _id: 1 }).limit(limit).lean();
  const eventIds = events.map(e => e._id);
  if (eventIds.length) {
    await EventCache.updateMany(
      { _id: { $in: eventIds } },
      { $set: { aiIndexStatus: 'not_loaded', aiIndexError: '', retryRequestedAt: new Date() }, $unset: { aiIndexedAt: '' } }
    );
  }

  const transcriptQuery = {
    orgId,
    $or: [
      { aiIndexStatus: 'failed' },
      { aiIndexError: { $exists: true, $nin: ['', null] } },
      { 'ai.status': 'error' },
      { 'ai.detailedStatus': 'error' },
    ],
  };
  if (me) transcriptQuery['acl.allowedEmails'] = me;
  const transcripts = await Transcript.find(transcriptQuery).select({ _id: 1 }).limit(limit).lean();
  const transcriptIds = transcripts.map(t => t._id);
  if (transcriptIds.length) {
    await Transcript.updateMany(
      { _id: { $in: transcriptIds } },
      { $set: { aiIndexStatus: 'not_loaded', aiIndexError: '', 'ai.status': 'none', 'ai.error': '', 'ai.detailedStatus': 'none', 'ai.detailedError': '', retryRequestedAt: new Date() }, $unset: { aiIndexedAt: '' } }
    );
    await TranscriptChunk.deleteMany({ orgId, transcriptDocId: { $in: transcriptIds } });
  }
  if (me) {
    await UserSyncState.updateOne({ orgId, userEmail: me }, { $set: { lastSyncStatus: 'retry_requested', lastSyncError: '', lastRetryRequestedAt: new Date() } }, { upsert: true });
  }
  return { events: eventIds.length, transcripts: transcriptIds.length };
}

module.exports = { resetFailedTranscriptJobs };
