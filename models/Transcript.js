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

    participantEmails: { type: [String], default: [], index: true },

    vtt: { type: String, default: '' },
    text: { type: String, default: '' },

    ai: {
      status: { type: String, enum: ['none', 'queued', 'done', 'error'], default: 'none' },
      model: { type: String, default: '' },
      summary: { type: String, default: '' },
      error: { type: String, default: '' },
      createdAt: { type: Date },
      updatedAt: { type: Date },
    },
  },
  { timestamps: true }
);

// ✅ Unique per occurrence + transcript
// (eventId might be empty for old records, but new ones will have it)
TranscriptSchema.index({ orgId: 1, eventId: 1, transcriptId: 1 }, { unique: true });

module.exports = mongoose.model('Transcript', TranscriptSchema);
