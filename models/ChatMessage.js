const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Org', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role: { type: String, enum: ['user', 'assistant'], required: true },
  message: { type: String, default: '' },
  sources: { type: Array, default: [] },
  model: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, index: true },
});

ChatMessageSchema.index({ orgId: 1, userId: 1, createdAt: -1 });
module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
