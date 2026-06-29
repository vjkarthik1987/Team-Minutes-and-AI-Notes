const mongoose = require('mongoose');

const IntelligenceCacheSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  scopeType: { type: String, enum: ['thread', 'meeting', 'week'], required: true, index: true },
  scopeId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  scopeKey: { type: String, default: '', index: true },
  kind: { type: String, required: true, index: true },
  title: { type: String, default: '' },
  answer: { type: String, default: '' },
  model: { type: String, default: '' },
  sourceHash: { type: String, default: '', index: true },
  sources: { type: Array, default: [] },
  generatedAt: { type: Date, default: Date.now, index: true },
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  generatedByEmail: { type: String, default: '', lowercase: true, trim: true },
  refreshCount: { type: Number, default: 0 },
  review: {
    status: { type: String, enum: ['unreviewed','reviewed','needs_correction'], default: 'unreviewed', index: true },
    reviewedAt: { type: Date, default: null },
    reviewedByEmail: { type: String, default: '', lowercase: true, trim: true },
    note: { type: String, default: '' },
  },
  acl: {
    allowedEmails: { type: [String], default: [], index: true },
    updatedAt: { type: Date },
  },
}, { timestamps: true });

IntelligenceCacheSchema.index({ orgId: 1, scopeType: 1, scopeKey: 1, kind: 1 }, { unique: false });
IntelligenceCacheSchema.index({ orgId: 1, scopeType: 1, scopeId: 1, kind: 1 });

module.exports = mongoose.model('IntelligenceCache', IntelligenceCacheSchema);
