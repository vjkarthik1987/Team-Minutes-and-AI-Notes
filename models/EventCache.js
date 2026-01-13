// models/EventCache.js
const mongoose = require('mongoose');

const EventCacheSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },

    // cache is per user (so "my meetings only" is trivial)
    userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },

    // Graph event id
    eventId: { type: String, required: true },

    subject: { type: String, default: '' },
    startDateTime: { type: String, default: '' },
    endDateTime: { type: String, default: '' },
    location: { type: String, default: '' },

    organizerEmail: { type: String, default: '' },
    attendeeEmails: { type: [String], default: [] },

    // only store if transcript exists
    hasTranscript: { type: Boolean, default: false, index: true },

    // we store the IDs needed to open transcript quickly
    transcripts: {
      type: [
        {
          meetingId: String,
          transcriptId: String,
        },
      ],
      default: [],
    },

    syncedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

EventCacheSchema.index({ orgId: 1, userEmail: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model('EventCache', EventCacheSchema);
