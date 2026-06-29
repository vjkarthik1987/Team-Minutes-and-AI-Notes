const mongoose = require('mongoose');

const ThreadMetricPointSchema = new mongoose.Schema({
  value: { type: Number, required: true },
  note: { type: String, default: '' },
  recordedAt: { type: Date, required: true, index: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recordedByEmail: { type: String, default: '', lowercase: true, trim: true },
}, { _id: true, timestamps: true });

const ThreadMetricSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'MeetingThread', required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  unit: { type: String, default: 'count' },
  chartType: { type: String, enum: ['line', 'bar', 'area', 'step', 'pie', 'cumulative', 'scatter', 'gauge'], default: 'line' },
  direction: { type: String, enum: ['higher_is_better', 'lower_is_better', 'neutral'], default: 'neutral' },
  points: { type: [ThreadMetricPointSchema], default: [] },
  acl: {
    allowedEmails: { type: [String], default: [], index: true },
    updatedAt: { type: Date },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByEmail: { type: String, default: '', lowercase: true, trim: true },
}, { timestamps: true });

ThreadMetricSchema.index({ orgId: 1, threadId: 1, updatedAt: -1 });
ThreadMetricSchema.index({ orgId: 1, 'acl.allowedEmails': 1 });

module.exports = mongoose.models.ThreadMetric || mongoose.model('ThreadMetric', ThreadMetricSchema);
