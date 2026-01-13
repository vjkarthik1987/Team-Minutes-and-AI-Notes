// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true },

    name: { type: String, trim: true, default: '' },
    email: { type: String, required: true, lowercase: true, trim: true },

    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    // Bound after first successful O365 login
    o365: {
      oid: { type: String, default: null }, // Azure AD user object id
      tid: { type: String, default: null }, // Azure AD tenant id
    },

    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Unique email per org
UserSchema.index({ org: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('User', UserSchema);
