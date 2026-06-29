const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  actorEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  action: { type: String, required: true, index: true },
  entityType: { type: String, default: '', index: true },
  entityId: { type: String, default: '', index: true },
  summary: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

AuditLogSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
