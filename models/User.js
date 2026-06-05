// models/User.js
const mongoose = require('mongoose');


const ROLE_ALIASES = {
  admin: 'super_admin',
  org_admin: 'super_admin',
  superadmin: 'super_admin',
  superAdmin: 'super_admin',
  user: 'general_user',
  member: 'general_user',
  normal: 'general_user',
};

function normalizeRole(role) {
  const raw = String(role || '').trim();
  return ROLE_ALIASES[raw] || raw || 'general_user';
}

const UserSchema = new mongoose.Schema(
  {
    org: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true },

    name: { type: String, trim: true, default: '' },
    email: { type: String, required: true, lowercase: true, trim: true },

    role: { type: String, enum: ['general_user', 'ceo', 'super_admin'], default: 'general_user' },

    permissions: {
      canAssignActions: { type: Boolean, default: false },
      canAssignFollowups: { type: Boolean, default: false },
      canViewAuditLog: { type: Boolean, default: false },
    },

    // v16.4: personal collaborator/delegate list.
    // These are not global admins; they are people this user trusts to contribute
    // context/actions to threads or prep workflows where explicit access is granted.
    collaborators: {
      type: [{
        email: { type: String, lowercase: true, trim: true },
        name: { type: String, trim: true, default: '' },
        role: { type: String, enum: ['assistant', 'delegate', 'collaborator'], default: 'collaborator' },
        canAddContext: { type: Boolean, default: true },
        canAddActions: { type: Boolean, default: false },
        addedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },

    // v16.6: user/org memory that helps the chatbot understand team structure,
    // aliases, employee names, responsibilities and persistent preferences.
    memoryBlocks: {
      type: [{
        scope: { type: String, enum: ['user', 'org'], default: 'user' },
        label: { type: String, trim: true, default: 'Memory note' },
        body: { type: String, default: '' },
        createdByEmail: { type: String, lowercase: true, trim: true, default: '' },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    // Bound after first successful O365 login
    o365: {
      oid: { type: String, default: null }, // Azure AD user object id
      tid: { type: String, default: null }, // Azure AD tenant id
    },

    lastLoginAt: { type: Date, default: null },
    firstLoginAt: { type: Date, default: null },
    loginCount: { type: Number, default: 0 },
    transcriptOnboardingDismissedAt: { type: Date, default: null },
    // inside User schema
    principals: {
      emails: { type: [String], default: [] }, // primary + aliases, lowercase
      updatedAt: { type: Date },
    },

  },
  { timestamps: true }
);

UserSchema.pre('validate', function normalizeLegacyRole() {
  this.role = normalizeRole(this.role);
});

UserSchema.statics.normalizeRole = normalizeRole;

// Unique email per org
UserSchema.index({ org: 1, email: 1 }, { unique: true });
UserSchema.index({ org: 1, 'principals.emails': 1 });
UserSchema.index({ org: 1, 'collaborators.email': 1 });

module.exports = mongoose.model('User', UserSchema);
