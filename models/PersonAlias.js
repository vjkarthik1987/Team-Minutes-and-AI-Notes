const mongoose = require('mongoose');

const PersonAliasSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  canonicalEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  canonicalName: { type: String, default: '' },
  alias: { type: String, required: true, trim: true, index: true },
  normalizedAlias: { type: String, required: true, lowercase: true, trim: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdByEmail: { type: String, default: '', lowercase: true, trim: true },
}, { timestamps: true });

PersonAliasSchema.index({ orgId: 1, normalizedAlias: 1 }, { unique: true });
PersonAliasSchema.index({ orgId: 1, canonicalEmail: 1 });

module.exports = mongoose.models.PersonAlias || mongoose.model('PersonAlias', PersonAliasSchema);
