const mongoose = require('mongoose');

const MeetingLinkSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  fromEventId: { type: String, required: true, index: true },
  toEventId: { type: String, required: true, index: true },
  fromICalUId: { type: String, default: '', index: true },
  toICalUId: { type: String, default: '', index: true },
  fromTranscriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null, index: true },
  toTranscriptDocId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null, index: true },
  fromSubject: { type: String, default: '' },
  toSubject: { type: String, default: '' },
  fromStartDateTime: { type: String, default: '' },
  toStartDateTime: { type: String, default: '' },
  fromOrganizerEmail: { type: String, default: '', lowercase: true, trim: true },
  toOrganizerEmail: { type: String, default: '', lowercase: true, trim: true },
  fromAttendeeEmails: { type: [String], default: [] },
  toAttendeeEmails: { type: [String], default: [] },
  relation: { type: String, enum: ['precursor_to', 'followup_to', 'continues', 'provides_context_for', 'resulted_from', 'related_to'], default: 'related_to', index: true },
  reason: { type: String, default: '' },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdByEmail: { type: String, default: '', lowercase: true, trim: true },
  acl: {
    allowedEmails: { type: [String], default: [], index: true },
    updatedAt: { type: Date },
  },
}, { timestamps: true });

MeetingLinkSchema.index({ orgId: 1, fromEventId: 1, toEventId: 1, relation: 1 }, { unique: true });
MeetingLinkSchema.index({ orgId: 1, 'acl.allowedEmails': 1, active: 1 });
MeetingLinkSchema.index({ orgId: 1, fromICalUId: 1, toICalUId: 1, active: 1 });

module.exports = mongoose.models.MeetingLink || mongoose.model('MeetingLink', MeetingLinkSchema);
