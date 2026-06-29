require('dotenv').config();
const mongoose = require('mongoose');
const { sweepOnce } = require('../workers/transcriptSweep.worker');

const MONGO = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/minutes';

(async () => {
  await mongoose.connect(MONGO);
  const stats = await sweepOnce();
  console.log('[manual transcript sweep]', stats);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error('[manual transcript sweep] failed:', e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
