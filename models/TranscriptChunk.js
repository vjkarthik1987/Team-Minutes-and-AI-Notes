// models/TranscriptChunk.js
const mongoose = require('mongoose');

const TranscriptChunkSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    transcriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', required: true, index: true },

    eventId: { type: String, default: '', index: true },
    meetingId: { type: String, default: '' },
    transcriptId: { type: String, default: '' },

    subject: { type: String, default: '' },
    startDateTime: { type: String, default: '' },

    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },

    charStart: { type: Number, default: 0 },
    charEnd: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'transcript_chunks' }
);

// idempotent key
TranscriptChunkSchema.index({ orgId: 1, transcriptDocId: 1, chunkIndex: 1 }, { unique: true });

// OPTIONAL but recommended (enables fast $text search)
TranscriptChunkSchema.index({ text: 'text' });

module.exports =
  mongoose.models.TranscriptChunk ||
  mongoose.model('TranscriptChunk', TranscriptChunkSchema);
