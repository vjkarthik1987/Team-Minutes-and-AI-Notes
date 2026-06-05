const mongoose = require('mongoose');

const SummaryDigestSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, lowercase: true, trim: true, index: true },
  type: { type: String, enum: ['daily', 'weekly', 'monthly', 'custom'], required: true, index: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  subject: { type: String, default: '' },
  body: { type: String, default: '' },
  sentAt: { type: Date, default: null },
  status: { type: String, enum: ['created', 'sent', 'error'], default: 'created' },
  error: { type: String, default: '' },
}, { timestamps: true });
SummaryDigestSchema.index({ orgId: 1, userId: 1, type: 1, periodStart: 1 }, { unique: true });
module.exports = mongoose.models.SummaryDigest || mongoose.model('SummaryDigest', SummaryDigestSchema);
