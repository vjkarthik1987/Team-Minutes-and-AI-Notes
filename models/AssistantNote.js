const mongoose = require('mongoose');

const AssistantNoteSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  principalUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  principalEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  principalName: { type: String, default: '' },
  assistantUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  assistantEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  assistantName: { type: String, default: '' },
  targetType: { type: String, enum: ['general', 'meeting', 'thread'], default: 'general', index: true },
  eventId: { type: String, default: '', index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', default: null, index: true },
  targetTitle: { type: String, default: '' },
  noteType: { type: String, enum: ['question', 'prep', 'followup', 'risk', 'decision', 'general', 'thread_note', 'meeting_note'], default: 'general', index: true },
  title: { type: String, default: '' },
  body: { type: String, required: true },
  status: { type: String, enum: ['new', 'seen', 'archived'], default: 'new', index: true },
  seenAt: { type: Date, default: null },
  seenByEmail: { type: String, default: '', lowercase: true, trim: true },
  archivedAt: { type: Date, default: null },
  acl: {
    allowedEmails: { type: [String], default: [], index: true },
    updatedAt: { type: Date },
  },
}, { timestamps: true });

AssistantNoteSchema.index({ orgId: 1, principalEmail: 1, createdAt: -1 });
AssistantNoteSchema.index({ orgId: 1, assistantEmail: 1, createdAt: -1 });
AssistantNoteSchema.index({ orgId: 1, eventId: 1, createdAt: -1 });
AssistantNoteSchema.index({ orgId: 1, threadId: 1, createdAt: -1 });

module.exports = mongoose.models.AssistantNote || mongoose.model('AssistantNote', AssistantNoteSchema);
