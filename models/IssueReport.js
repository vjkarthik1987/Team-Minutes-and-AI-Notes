const mongoose = require('mongoose');

const IssueReportSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  reporterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  reporterEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
  reporterName: { type: String, default: '' },
  targetType: { type: String, enum: ['summary','transcript','thread','thread_intelligence','meeting_prep','other'], default: 'other', index: true },
  targetId: { type: String, default: '', index: true },
  targetTitle: { type: String, default: '' },
  issueType: { type: String, enum: ['wrong_transcript','wrong_meeting','bad_ai_summary','missing_transcript','bad_thread_intelligence','permission_issue','other'], default: 'other', index: true },
  details: { type: String, default: '' },
  status: { type: String, enum: ['open','reviewing','resolved','dismissed'], default: 'open', index: true },
  resolvedAt: { type: Date, default: null },
  resolvedByEmail: { type: String, default: '', lowercase: true, trim: true },
  route: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

IssueReportSchema.index({ orgId: 1, createdAt: -1 });
IssueReportSchema.index({ orgId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.IssueReport || mongoose.model('IssueReport', IssueReportSchema);
