const mongoose = require('mongoose');
const ThreadScoreSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', required: true, index: true },
  healthScore: { type: Number, default: 70 },
  healthLabel: { type: String, enum: ['Healthy','Attention Needed','Slipping','Critical'], default: 'Healthy', index: true },
  reason: { type: String, default: '' },
  unresolvedActions: { type: Number, default: 0 },
  overdueActions: { type: Number, default: 0 },
  lastActivityAt: { type: Date, default: null },
  computedAt: { type: Date, default: Date.now },
}, { timestamps: true });
ThreadScoreSchema.index({ orgId: 1, threadId: 1 }, { unique: true });
module.exports = mongoose.models.ThreadScore || mongoose.model('ThreadScore', ThreadScoreSchema);
