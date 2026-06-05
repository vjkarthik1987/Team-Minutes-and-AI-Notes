
const mongoose = require('mongoose');

const ThreadEntrySchema = new mongoose.Schema({
  kind: { type: String, enum: ['note', 'call', 'generated_note', 'decision', 'risk', 'action', 'status', 'meeting'], required: true, index: true },
  sourceType: { type: String, enum: ['Teams meeting','Manual note','Call note','AI-generated note','Decision','Risk','Action','Manual meeting'], default: 'Manual note', index: true },
  visibility: { type: String, enum: ['private','thread','org'], default: 'thread', index: true },
  confidence: { type: String, enum: ['','Low','Medium','High'], default: '' },
  people: { type: [String], default: [] },
  occurredAt: { type: Date },
  title: { type: String, default: '' },
  body: { type: String, default: '' },
  ownerEmail: { type: String, default: '', lowercase: true, trim: true },
  dueDate: { type: Date },
  status: { type: String, default: '' },
  severity: { type: String, enum: ['', 'Low', 'Medium', 'High', 'Critical'], default: '' },
  linkedTranscriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript' },
  checklist: [{
    text: { type: String, default: '' },
    done: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  }],
  files: [{
    originalName: { type: String, default: '' },
    fileName: { type: String, default: '' },
    path: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date },
    uploadedByEmail: { type: String, default: '', lowercase: true, trim: true },
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByEmail: { type: String, default: '', lowercase: true, trim: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const MeetingThreadSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  name: { type: String, required: true, trim: true },
  objective: { type: String, default: '' },
  desiredOutcome: { type: String, default: '' }, // legacy field; v16 uses objective as the single Outcome field
  description: { type: String, default: '' },
  status: { type: String, enum: ['Active', 'At Risk', 'Blocked', 'Closed'], default: 'Active', index: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  ownerEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  contributorEmails: { type: [String], default: [], index: true },
  viewerEmails: { type: [String], default: [], index: true },
  memberEmails: { type: [String], default: [], index: true },
  tags: { type: [String], default: [] },
  clientName: { type: String, default: '' },
  priority: { type: String, enum: ['', 'Low', 'Medium', 'High', 'Critical'], default: '' },
  meetingIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transcript' }],
  entries: { type: [ThreadEntrySchema], default: [] },
  links: [{
    fromTranscriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript' },
    toTranscriptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript' },
    relation: { type: String, enum: ['precedes', 'follows', 'related', 'same_recurring_chain'], default: 'precedes' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  }],
  recurringChain: {
    enabled: { type: Boolean, default: false, index: true },
    matchMode: { type: String, enum: ['manual', 'subject'], default: 'manual' },
    subjectKey: { type: String, default: '', index: true },
    lastConnectedAt: { type: Date },
    connectedCount: { type: Number, default: 0 },
  },
  deletedAt: { type: Date, default: null, index: true },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  acl: {
    allowedEmails: { type: [String], default: [], index: true },
    updatedAt: { type: Date },
  },
  dailyDigest: {
    whatChanged: { type: String, default: '' },
    openRisks: { type: String, default: '' },
    overdueActions: { type: String, default: '' },
    attentionToday: { type: String, default: '' },
    updatedAt: { type: Date },
  },
  ai: {
    status: { type: String, enum: ['none', 'queued', 'done', 'error'], default: 'none' },
    model: { type: String, default: '' },
    progressSummary: { type: String, default: '' },
    executiveMemory: { type: String, default: '' },
    insight: { type: String, default: '' },
    insightEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    insightEditedByEmail: { type: String, default: '', lowercase: true, trim: true },
    insightEditedAt: { type: Date },
    healthScore: { type: Number, default: 0 },
    healthLabel: { type: String, default: '' },
    confidence: { type: String, enum: ['', 'Low', 'Medium', 'High'], default: '' },
    suggestedStatus: { type: String, default: '' },
    healthUpdatedByEmail: { type: String, default: '', lowercase: true, trim: true },
    healthUpdatedAt: { type: Date },
    lastAnalyzedAt: { type: Date },
    error: { type: String, default: '' },
    updatedAt: { type: Date },
  },
  keyDecisionsNeeded: { type: String, default: '' },
  keyGaps: { type: String, default: '' },
  keyQuestions: { type: String, default: '' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

MeetingThreadSchema.index({ orgId: 1, createdAt: -1 });
MeetingThreadSchema.index({ orgId: 1, status: 1, updatedAt: -1 });
MeetingThreadSchema.index({ orgId: 1, deletedAt: 1, updatedAt: -1 });
MeetingThreadSchema.index({ orgId: 1, 'recurringChain.subjectKey': 1 });
MeetingThreadSchema.index({ orgId: 1, 'acl.allowedEmails': 1 });
module.exports = mongoose.model('MeetingThread', MeetingThreadSchema);
