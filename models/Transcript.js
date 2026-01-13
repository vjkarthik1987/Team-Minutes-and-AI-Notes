// models/Transcript.js
const mongoose = require('mongoose');

const TranscriptSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    // Graph identifiers
    meetingId: { type: String, required: true },
    transcriptId: { type: String, required: true },

    // Meeting metadata (optional but useful)
    subject: { type: String },
    startDateTime: { type: String },
    endDateTime: { type: String },

    // Stored transcript
    vtt: { type: String, default: '' },
    text: { type: String, default: '' }, // cleaned/plain text

    // Summary (created once)
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

// ✅ This is the key: “create only once”
TranscriptSchema.index({ orgId: 1, meetingId: 1, transcriptId: 1 }, { unique: true });

module.exports = mongoose.model('Transcript', TranscriptSchema);
