const mongoose = require('mongoose');
const DecisionItemSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
  ownerEmail: { type: String, default: '', lowercase: true, trim: true },
  ownerName: { type: String, default: '' },
  status: { type: String, enum: ['pending','decided','dropped'], default: 'pending', index: true },
  sourceType: { type: String, default: '' },
  sourceId: { type: String, default: '' },
  sourceTitle: { type: String, default: '' },
  confidence: { type: Number, default: 0.55 },
}, { timestamps: true });
module.exports = mongoose.models.DecisionItem || mongoose.model('DecisionItem', DecisionItemSchema);
