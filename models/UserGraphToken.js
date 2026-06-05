// models/UserGraphToken.js
const mongoose = require('mongoose');

const UserGraphTokenSchema = new mongoose.Schema(
  {
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    tid: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    scope: { type: String, default: '' },
    expiresAt: { type: Date, default: null },
    lastRefreshedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

UserGraphTokenSchema.index({ org: 1, email: 1 });

module.exports = mongoose.models.UserGraphToken || mongoose.model('UserGraphToken', UserGraphTokenSchema);
