// models/UserSyncState.js
const mongoose = require('mongoose');

const UserSyncStateSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    userEmail: { type: String, required: true, index: true },

    // coverage window (what ranges have been synced at least once)
    syncedFrom: { type: Date, default: null },
    syncedTo: { type: Date, default: null },

    // last time any sync ran
    lastSyncedAt: { type: Date, default: null },

    // last time we did an "older backfill sweep" to catch forwarded invites
    lastBackfillAt: { type: Date, default: null },
  },
  { timestamps: true }
);

UserSyncStateSchema.index({ orgId: 1, userEmail: 1 }, { unique: true });

module.exports = mongoose.model('UserSyncState', UserSyncStateSchema);
