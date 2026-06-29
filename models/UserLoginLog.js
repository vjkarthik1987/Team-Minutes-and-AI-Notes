const mongoose = require('mongoose');

const UserLoginLogSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  email: { type: String, default: '', lowercase: true, trim: true, index: true },
  name: { type: String, default: '' },
  role: { type: String, default: '' },
  loginAt: { type: Date, default: Date.now, index: true },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  status: { type: String, enum: ['success', 'failed'], default: 'success', index: true },
  reason: { type: String, default: '' },
}, { timestamps: true });

UserLoginLogSchema.index({ orgId: 1, loginAt: -1 });
module.exports = mongoose.models.UserLoginLog || mongoose.model('UserLoginLog', UserLoginLogSchema);
