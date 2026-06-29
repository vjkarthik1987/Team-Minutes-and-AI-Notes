const mongoose = require('mongoose');

const AssistantMappingSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  principalUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  principalEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  principalName: { type: String, default: '' },
  assistantUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  assistantEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  assistantName: { type: String, default: '' },
  permissions: {
    canAddGeneralNotes: { type: Boolean, default: true },
    canAddMeetingNotes: { type: Boolean, default: true },
    canAddThreadNotes: { type: Boolean, default: true },
    canAddQuestions: { type: Boolean, default: true },
    canAddFollowups: { type: Boolean, default: true },
    canAddRisks: { type: Boolean, default: true },
    canSeeOwnNotes: { type: Boolean, default: true },
  },
  source: { type: String, enum: ['user', 'org_admin'], default: 'user', index: true },
  active: { type: Boolean, default: true, index: true },
  createdByEmail: { type: String, default: '', lowercase: true, trim: true },
  removedAt: { type: Date, default: null },
  removedByEmail: { type: String, default: '', lowercase: true, trim: true },
}, { timestamps: true });

AssistantMappingSchema.index({ orgId: 1, principalEmail: 1, assistantEmail: 1 }, { unique: true });
AssistantMappingSchema.index({ orgId: 1, assistantEmail: 1, active: 1 });
AssistantMappingSchema.index({ orgId: 1, principalEmail: 1, active: 1 });

module.exports = mongoose.models.AssistantMapping || mongoose.model('AssistantMapping', AssistantMappingSchema);
