const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

function normalizeDomains(arr) {
  return (arr || [])
    .map(d => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

const OrgSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },

    allowedDomains: {
      type: [String],
      default: [],
      set: normalizeDomains,
    },

    // ✅ Org login (local)
    loginEmail: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },

    // Office 365 / Entra tenant details (not secrets)
    o365: {
      tenantId: { type: String, default: null },
      enforceTenantMatch: { type: Boolean, default: true },
    },

    graph: {
      isConnected: { type: Boolean, default: true },
      consentedAt: { type: Date, default: null },
      scopesGranted: { type: [String], default: [] },
      healthStatus: {
        type: String,
        enum: ['not_connected', 'ok', 'needs_reconsent', 'failing'],
        default: 'not_connected',
      },
      lastHealthCheckAt: { type: Date, default: null },
      lastError: {
        code: { type: String, default: null },
        message: { type: String, default: null },
        at: { type: Date, default: null },
      },
    },

    features: {
      checkTranscripts: { type: Boolean, default: true },
      debugTranscripts: { type: Boolean, default: false },
    },

    retention: {
      meetingDays: { type: Number, default: 90 },
      transcriptDays: { type: Number, default: 30 },
      storeRawTranscript: { type: Boolean, default: false },
    },

    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true }
);

OrgSchema.index({ slug: 1 }, { unique: true });
OrgSchema.index({ loginEmail: 1 }, { unique: true }); // ✅ org login unique

OrgSchema.statics.hashPassword = async function (plain) {
  const saltRounds = 12;
  return bcrypt.hash(plain, saltRounds);
};

OrgSchema.methods.validatePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = mongoose.model('Org', OrgSchema);
