const mongoose = require('mongoose');

const PersonSignalSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  personEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  personName: { type: String, default: '' },
  signalType: { type: String, enum: ['ownership','blocker','followup','overload','collaboration','alias'], required: true, index: true },
  title: { type: String, required: true },
  detail: { type: String, default: '' },
  severity: { type: String, enum: ['Low','Medium','High','Critical'], default: 'Medium', index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', default: null, index: true },
  actionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActionItem', default: null, index: true },
  sourceType: { type: String, default: '' },
  sourceId: { type: String, default: '' },
  detectedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

PersonSignalSchema.index({ orgId: 1, personEmail: 1, signalType: 1, detectedAt: -1 });
module.exports = mongoose.models.PersonSignal || mongoose.model('PersonSignal', PersonSignalSchema);
