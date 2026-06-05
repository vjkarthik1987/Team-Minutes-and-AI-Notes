const mongoose = require('mongoose');

const ErrorLogSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', default: null, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  actorEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  level: { type: String, enum: ['info','warn','error'], default: 'error', index: true },
  source: { type: String, default: 'app', index: true },
  message: { type: String, default: '' },
  stack: { type: String, default: '' },
  route: { type: String, default: '' },
  method: { type: String, default: '' },
  statusCode: { type: Number, default: 500, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true });

ErrorLogSchema.index({ orgId: 1, createdAt: -1 });
ErrorLogSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.models.ErrorLog || mongoose.model('ErrorLog', ErrorLogSchema);
