/**
 * scripts/cleanupTranscriptChunks.js
 *
 * Deletes ALL transcript chunks.
 * Does NOT touch transcripts, orgs, users, or ACLs.
 *
 * Usage:
 *   node scripts/cleanupTranscriptChunks.js
 *   MONGODB_URI="mongodb+srv://..." node scripts/cleanupTranscriptChunks.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const TranscriptChunk = require('../models/TranscriptChunk');

const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL;

if (!MONGO) {
  console.error('❌ Missing MongoDB URI (set MONGODB_URI)');
  process.exit(1);
}

async function run() {
  console.log('[cleanup] connecting to Mongo…');
  await mongoose.connect(MONGO);

  const before = await TranscriptChunk.countDocuments({});
  console.log(`[cleanup] chunks before delete: ${before}`);

  const result = await TranscriptChunk.deleteMany({});
  console.log(`[cleanup] deleted chunks: ${result.deletedCount}`);

  const after = await TranscriptChunk.countDocuments({});
  console.log(`[cleanup] chunks after delete: ${after}`);

  await mongoose.disconnect();
  console.log('[cleanup] done');
  process.exit(0);
}

run().catch(err => {
  console.error('[cleanup] failed:', err);
  process.exit(1);
});
