const mongoose = require('mongoose');

const PageVisitLogSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  actorType: { type: String, enum: ['user', 'org'], default: 'user', index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  actorEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  actorName: { type: String, default: '' },
  actorRole: { type: String, default: '' },
  method: { type: String, default: 'GET', index: true },
  route: { type: String, default: '', index: true },
  path: { type: String, default: '', index: true },
  statusCode: { type: Number, default: 0, index: true },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  referrer: { type: String, default: '' },
  isMutation: { type: Boolean, default: false, index: true },
  durationMs: { type: Number, default: 0 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

PageVisitLogSchema.index({ orgId: 1, createdAt: -1 });
PageVisitLogSchema.index({ orgId: 1, actorEmail: 1, createdAt: -1 });
PageVisitLogSchema.index({ orgId: 1, path: 1, createdAt: -1 });

module.exports = mongoose.models.PageVisitLog || mongoose.model('PageVisitLog', PageVisitLogSchema);
