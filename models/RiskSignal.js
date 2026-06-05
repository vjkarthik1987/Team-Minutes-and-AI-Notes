const mongoose = require('mongoose');
const RiskSignalSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
  severity: { type: String, enum: ['Low','Medium','High','Critical'], default: 'Medium', index: true },
  status: { type: String, enum: ['open','dismissed','resolved'], default: 'open', index: true },
  sourceType: { type: String, default: '' },
  sourceId: { type: String, default: '' },
  sourceTitle: { type: String, default: '' },
  detectedAt: { type: Date, default: Date.now },
  confidence: { type: Number, default: 0.6 },
}, { timestamps: true });
module.exports = mongoose.models.RiskSignal || mongoose.model('RiskSignal', RiskSignalSchema);
