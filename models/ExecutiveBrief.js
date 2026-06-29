const mongoose = require('mongoose');

const BriefItemSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
  why: { type: String, default: '' },
  suggestedNextStep: { type: String, default: '' },
  urgency: { type: String, enum: ['Low','Medium','High','Critical'], default: 'Medium' },
  confidence: { type: Number, default: 0.6 },
  ownerName: { type: String, default: '' },
  ownerEmail: { type: String, default: '', lowercase: true, trim: true },
  sourceType: { type: String, default: '' },
  sourceId: { type: String, default: '' },
  sourceTitle: { type: String, default: '' },
  sourceDate: { type: Date, default: null },
}, { _id: true });

const ExecutiveBriefSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  scope: { type: String, enum: ['personal','org'], default: 'personal', index: true },
  briefDate: { type: String, required: true, index: true },
  status: { type: String, enum: ['generated','stale','error'], default: 'generated', index: true },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: 'heuristic-v20' },
  headline: { type: String, default: '' },
  executiveSummary: { type: String, default: '' },
  focusAreas: { type: [BriefItemSchema], default: [] },
  silentRisks: { type: [BriefItemSchema], default: [] },
  followUps: { type: [BriefItemSchema], default: [] },
  importantMeetings: { type: [BriefItemSchema], default: [] },
  slippingThreads: { type: [BriefItemSchema], default: [] },
  pendingDecisions: { type: [BriefItemSchema], default: [] },
  staleActions: { type: [BriefItemSchema], default: [] },
  stats: {
    meetingsToday: { type: Number, default: 0 },
    openActions: { type: Number, default: 0 },
    overdueActions: { type: Number, default: 0 },
    slippingThreads: { type: Number, default: 0 },
    pendingDecisions: { type: Number, default: 0 },
  },
  rawSignals: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

ExecutiveBriefSchema.index({ orgId: 1, userEmail: 1, scope: 1, briefDate: 1 }, { unique: true });
module.exports = mongoose.models.ExecutiveBrief || mongoose.model('ExecutiveBrief', ExecutiveBriefSchema);
