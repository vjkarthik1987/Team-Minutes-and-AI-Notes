const mongoose = require('mongoose');

const MeetingContextSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  eventId: { type: String, default: '', index: true },
  transcriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null, index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', default: null, index: true },
  contextType: { type: String, enum: ['call','general','generated','manual_meeting','personal_note'], default: 'general', index: true },
  sourceType: { type: String, enum: ['Manual note','Call note','AI-generated note','Manual meeting','Personal note'], default: 'Manual note', index: true },
  visibility: { type: String, enum: ['private','thread','org'], default: 'thread', index: true },
  people: { type: [String], default: [] },
  occurredAt: { type: Date },
  remindUntil: { type: Date, default: null, index: true },
  noteStatus: { type: String, enum: ['active','done','archived'], default: 'active', index: true },
  addedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  addedByEmail: { type: String, default: '', lowercase: true, trim: true },
  title: { type: String, default: '' },
  contextText: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileText: { type: String, default: '' },
  originalName: { type: String, default: '' },
  storedName: { type: String, default: '' },
  filePath: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  sizeBytes: { type: Number, default: 0 },
  acl: { allowedEmails: { type: [String], default: [], index: true }, updatedAt: { type: Date } },
}, { timestamps: true });

MeetingContextSchema.index({ orgId: 1, eventId: 1, createdAt: -1 });
module.exports = mongoose.models.MeetingContext || mongoose.model('MeetingContext', MeetingContextSchema);
