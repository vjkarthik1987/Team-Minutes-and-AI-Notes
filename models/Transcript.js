// models/Transcript.js
const mongoose = require('mongoose');

const TranscriptSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    // ✅ Calendar occurrence ID (unique per recurring occurrence)
    eventId: { type: String, default: '', index: true },

    // Graph identifiers
    meetingId: { type: String, required: true },
    transcriptId: { type: String, required: true },

    subject: { type: String },
    startDateTime: { type: String },
    endDateTime: { type: String },
    // Actual Graph transcript timing. This is critical for duplicated/recurring Teams links.
    transcriptCreatedDateTime: { type: String, default: '' },
    transcriptStartDateTime: { type: String, default: '' },
    transcriptEndDateTime: { type: String, default: '' },

    participantEmails: { type: [String], default: [], index: true },

    vtt: { type: String, default: '' },
    text: { type: String, default: '' },
    acl: {
      allowedEmails: { type: [String], default: [] }, // canonical
      updatedAt: { type: Date },
    },

    // Separate RAG/index status from transcript save status.
    aiIndexStatus: { type: String, enum: ['not_loaded', 'processing', 'indexed', 'failed'], default: 'not_loaded', index: true },
    aiIndexedAt: { type: Date, default: null },
    aiIndexError: { type: String, default: '' },
    processingLock: {
      actionItemsGeneratedAt: { type: Date, default: null },
      actionItemsGeneratedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      actionItemsModel: { type: String, default: '' },
      actionItemsFailedAt: { type: Date, default: null },
      actionItemsFailureCount: { type: Number, default: 0 },
      actionItemsLastError: { type: String, default: '' },
    },

    ai: {
      status: { type: String, enum: ['none', 'queued', 'done', 'error'], default: 'none' },
      model: { type: String, default: '' },
      summary: { type: String, default: '' },
      error: { type: String, default: '' },
      createdAt: { type: Date },
      updatedAt: { type: Date },
      detailedStatus: { type: String, enum: ['none', 'queued', 'done', 'error'], default: 'none' },
      detailedModel: { type: String, default: '' },
      detailedNotes: { type: String, default: '' },
      detailedError: { type: String, default: '' },
      detailedCreatedAt: { type: Date },
      detailedUpdatedAt: { type: Date },
      reviewed: { type: Boolean, default: false, index: true },
      reviewedAt: { type: Date, default: null },
      reviewedByEmail: { type: String, default: '', lowercase: true, trim: true },
      reviewNote: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

// ✅ Unique per occurrence + transcript
// (eventId might be empty for old records, but new ones will have it)
TranscriptSchema.index({ orgId: 1, eventId: 1, transcriptId: 1 }, { unique: true });
TranscriptSchema.index({ orgId: 1, 'acl.allowedEmails': 1, startDateTime: -1 });
TranscriptSchema.index({ orgId: 1, meetingId: 1, transcriptId: 1 });

module.exports = mongoose.model('Transcript', TranscriptSchema);
