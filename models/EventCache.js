// models/EventCache.js
const mongoose = require('mongoose');

const EventCacheSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    // cache is per user (so "my meetings only" is trivial)
    userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },

    // Graph event id
    eventId: { type: String, required: true },
    iCalUId: { type: String, default: '', index: true },
    seriesMasterId: { type: String, default: '', index: true },
    importedSource: { type: String, default: '' },
    importedAt: { type: Date, default: null },
    importedByEmail: { type: String, default: '', lowercase: true, trim: true },

    subject: { type: String, default: '' },
    startDateTime: { type: String, default: '' },
    endDateTime: { type: String, default: '' },
    location: { type: String, default: '' },
    bodyPreview: { type: String, default: '' },

    organizerEmail: { type: String, default: '' },
    attendeeEmails: { type: [String], default: [] },

    // only store if transcript exists
    hasTranscript: { type: Boolean, default: false, index: true },

    // AI/RAG indexing status is intentionally separate from transcript presence.
    // A meeting can have a transcript but still not be searchable by chat yet.
    aiIndexStatus: { type: String, enum: ['not_loaded', 'processing', 'indexed', 'failed'], default: 'not_loaded', index: true },
    aiIndexedAt: { type: Date, default: null },
    aiIndexError: { type: String, default: '' },

    // we store the IDs needed to open transcript quickly
    linkedThreadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', default: null, index: true },
    linkedThreadName: { type: String, default: '' },
    precedingEventId: { type: String, default: '', index: true },
    precedingTranscriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null },
    precedingSubject: { type: String, default: '' },

    transcripts: {
      type: [
        {
          transcriptDocId: String,
          meetingId: String,
          transcriptId: String,
          transcriptCreatedDateTime: String,
          transcriptStartDateTime: String,
          transcriptEndDateTime: String,
        },
      ],
      default: [],
    },

    syncedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

EventCacheSchema.index({ orgId: 1, userEmail: 1, eventId: 1 }, { unique: true });
EventCacheSchema.index({ orgId: 1, iCalUId: 1 });
EventCacheSchema.index({ orgId: 1, seriesMasterId: 1 });

module.exports = mongoose.model('EventCache', EventCacheSchema);
