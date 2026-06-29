const mongoose = require('mongoose');

const ActionItemSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    transcriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null, index: true },
    eventId: { type: String, default: '', index: true },
    meetingId: { type: String, default: '' },
    transcriptId: { type: String, default: '' },
    meetingSubject: { type: String, default: '' },
    meetingStartDateTime: { type: String, default: '' },

    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    ownerName: { type: String, default: 'Unassigned' },
    ownerEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
    assignedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedByEmail: { type: String, default: '', lowercase: true, trim: true },
    source: { type: String, enum: ['ai_generated', 'manual'], default: 'ai_generated', index: true },
    dueDate: { type: String, default: 'Unclear' },
    dueDateISO: { type: Date, default: null, index: true },
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Unclear'], default: 'Unclear' },
    status: { type: String, enum: ['Open', 'In Progress', 'Waiting', 'Done', 'Dropped'], default: 'Open', index: true },
    confidence: { type: Number, default: 0 },
    evidence: { type: String, default: '' },
    blockedReason: { type: String, default: '' },
    escalated: { type: Boolean, default: false, index: true },
    escalatedAt: { type: Date, default: null },
    escalatedByEmail: { type: String, default: '', lowercase: true, trim: true },
    escalationNote: { type: String, default: '' },
    comments: [{
      body: { type: String, default: '' },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      createdByEmail: { type: String, default: '', lowercase: true, trim: true },
      createdAt: { type: Date, default: Date.now },
    }],

    acl: {
      allowedEmails: { type: [String], default: [], index: true },
      updatedAt: { type: Date },
    },
    generatedByModel: { type: String, default: '' },
    generatedAt: { type: Date, default: Date.now },

    recurrence: {
      enabled: { type: Boolean, default: false, index: true },
      frequency: { type: String, enum: ['', 'daily', 'weekly', 'monthly'], default: '' },
      interval: { type: Number, default: 1 },
      nextDueAt: { type: Date, default: null, index: true },
      parentActionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActionItem', default: null },
    },
  },
  { timestamps: true }
);

ActionItemSchema.index({ orgId: 1, transcriptDocId: 1, title: 1 });
ActionItemSchema.index({ orgId: 1, 'acl.allowedEmails': 1, status: 1, meetingStartDateTime: -1 });
ActionItemSchema.index({ orgId: 1, ownerEmail: 1, status: 1 });

module.exports = mongoose.models.ActionItem || mongoose.model('ActionItem', ActionItemSchema);
