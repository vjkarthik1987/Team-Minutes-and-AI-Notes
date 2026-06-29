const mongoose = require('mongoose');

const BriefingFileSchema = new mongoose.Schema({
  originalName: { type: String, default: '' },
  fileName: { type: String, default: '' },
  path: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const BriefingSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fromEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  fromName: { type: String, default: '' },
  toEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  toName: { type: String, default: '' },
  title: { type: String, default: '' },
  body: { type: String, default: '' },
  priority: { type: String, enum: ['Low','Medium','High','Critical'], default: 'Medium', index: true },
  relatedThreadIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', index: true }],
  relatedThreadsSnapshot: [{ threadId: String, name: String }],
  actionItems: [{
    text: { type: String, default: '' },
    status: { type: String, enum: ['Open','Done'], default: 'Open' },
    createdAt: { type: Date, default: Date.now },
  }],
  files: { type: [BriefingFileSchema], default: [] },
  status: { type: String, enum: ['active','dismissed','ended','archived'], default: 'active', index: true },
  dismissedAt: { type: Date },
  endedAt: { type: Date },
  expiresAt: { type: Date },
}, { timestamps: true });

BriefingSchema.index({ orgId: 1, toEmail: 1, status: 1, updatedAt: -1 });
BriefingSchema.index({ orgId: 1, fromEmail: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('Briefing', BriefingSchema);
