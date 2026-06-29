/**
 * scripts/buildTranscriptChunks.js
 *
 * Usage:
 *   node scripts/buildTranscriptChunks.js --mongo "mongodb+srv://..." --limit 50
 *   MONGODB_URI="mongodb+srv://..." node scripts/buildTranscriptChunks.js
 *
 * Optional:
 *   --org <slug>     only chunk transcripts for a specific org slug
 *   --onlyMissing    only create chunks when none exist (default true)
 *   --rebuild        delete existing chunks for each transcript and rebuild
 *   --chunkChars N   default 3600
 *   --overlapChars N default 500
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Transcript = require('../models/Transcript');
const Org = require('../models/Org');
const TranscriptChunk = require('../models/TranscriptChunk'); // ✅ IMPORT MODEL HERE

const { uniq, normalizeEmail, filterByAllowedDomains } = require('../utils/email');

// --------------------------
// Args
// --------------------------
function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const MONGO =
  getArg('mongo') ||
  process.env.MONGODB_URI ||     // ✅ FIX: support this
  process.env.MONGO_URI ||
  process.env.MONGO_URL;

const ORG_SLUG = getArg('org') || null;
const LIMIT = Number(getArg('limit') || process.env.CHAT_CHUNK_MAX || 0);

const CHUNK_CHARS = Number(getArg('chunkChars') || process.env.CHAT_CHUNK_CHARS || 3600);
const OVERLAP_CHARS = Number(getArg('overlapChars') || process.env.CHAT_CHUNK_OVERLAP || 500);

// default: only missing
const ONLY_MISSING = hasFlag('onlyMissing')
  ? true
  : (process.env.CHAT_CHUNK_ONLY_MISSING || 'true').toLowerCase() === 'true';

const REBUILD = hasFlag('rebuild');

if (!MONGO) {
  console.error('Missing MongoDB URI. Provide --mongo "..." or set MONGODB_URI.');
  process.exit(1);
}

// --------------------------
// Helpers
// --------------------------
function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkByChars(text, size, overlap) {
  const out = [];
  const s = cleanText(text);
  if (!s) return out;

  let i = 0;
  let idx = 0;

  while (i < s.length) {
    const start = i;
    const end = Math.min(s.length, i + size);
    const piece = s.slice(start, end).trim();

    if (piece) out.push({ chunkIndex: idx++, text: piece, charStart: start, charEnd: end });

    if (end >= s.length) break;
    i = Math.max(0, end - overlap);
  }

  return out;
}

async function computeAllowedEmailsForTranscript(doc, org) {
  const raw = Array.isArray(doc.participantEmails) ? doc.participantEmails : [];
  let emails = raw.map(normalizeEmail).filter(Boolean);
  emails = filterByAllowedDomains(emails, org?.allowedDomains);
  return uniq(emails);
}

// --------------------------
// Main
// --------------------------
async function main() {
  console.log('[chunks] starting with config:', {
    ONLY_MISSING,
    REBUILD,
    LIMIT: LIMIT || 'ALL',
    ORG_SLUG: ORG_SLUG || 'ALL',
    CHUNK_CHARS,
    OVERLAP_CHARS,
  });

  await mongoose.connect(MONGO);
  console.log('[chunks] connected');

  let orgQuery = {};
  if (ORG_SLUG) orgQuery.slug = ORG_SLUG;

  const orgs = await Org.find(orgQuery).select({ _id: 1, slug: 1, allowedDomains: 1 }).lean();
  if (!orgs.length) {
    console.error('[chunks] no orgs found for query:', orgQuery);
    process.exit(1);
  }

  const orgMap = new Map(orgs.map(o => [String(o._id), o]));
  const orgIds = orgs.map(o => o._id);

  const tQuery = { orgId: { $in: orgIds } };
  const cursor = Transcript.find(tQuery).sort({ createdAt: -1 }).cursor();

  let processed = 0;
  let chunked = 0;
  let skipped = 0;
  let aclBackfilled = 0;

  // ✅ skip reason counters (so you know why it skipped)
  let skipNoOrg = 0;
  let skipExists = 0;
  let skipNoText = 0;
  let skipNoParts = 0;

  for await (const doc of cursor) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    const org = orgMap.get(String(doc.orgId));
    if (!org) {
      skipped++; skipNoOrg++;
      continue;
    }

    // 1) Ensure canonical ACL exists (email list)
    const hasAcl = Array.isArray(doc.acl?.allowedEmails) && doc.acl.allowedEmails.length > 0;
    if (!hasAcl) {
      const allowedEmails = await computeAllowedEmailsForTranscript(doc, org);
      await Transcript.updateOne(
        { _id: doc._id },
        { $set: { 'acl.allowedEmails': allowedEmails, 'acl.updatedAt': new Date() } }
      );
      aclBackfilled++;
    }

    // 2) Rebuild option
    if (REBUILD) {
      await TranscriptChunk.deleteMany({ orgId: doc.orgId, transcriptDocId: doc._id });
    }

    // 3) Skip if already chunked (idempotent)
    if (!REBUILD && ONLY_MISSING) {
      const exists = await TranscriptChunk.findOne({ orgId: doc.orgId, transcriptDocId: doc._id })
        .select({ _id: 1 })
        .lean();
      if (exists) {
        skipped++; skipExists++;
        continue;
      }
    }

    const text = cleanText(doc.text || '');
    if (!text) {
      skipped++; skipNoText++;
      continue;
    }

    const parts = chunkByChars(text, CHUNK_CHARS, OVERLAP_CHARS);
    if (!parts.length) {
      skipped++; skipNoParts++;
      continue;
    }

    // 4) Upsert chunks via MODEL bulkWrite
    const ops = parts.map(p => ({
      updateOne: {
        filter: { orgId: doc.orgId, transcriptDocId: doc._id, chunkIndex: p.chunkIndex },
        update: {
          $set: {
            orgId: doc.orgId,
            transcriptDocId: doc._id,

            eventId: String(doc.eventId || ''),
            meetingId: String(doc.meetingId || ''),
            transcriptId: String(doc.transcriptId || ''),

            subject: String(doc.subject || ''),
            startDateTime: String(doc.startDateTime || ''),

            chunkIndex: p.chunkIndex,
            text: p.text,
            charStart: p.charStart,
            charEnd: p.charEnd,

            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      }
    }));

    await TranscriptChunk.bulkWrite(ops, { ordered: false });
    chunked++;

    if (processed % 25 === 0) {
      console.log(
        `[chunks] processed=${processed} chunked=${chunked} skipped=${skipped} aclBackfilled=${aclBackfilled}`
      );
    }
  }

  console.log('--- DONE ---');
  console.log({ processed, chunked, skipped, aclBackfilled });
  console.log('Skip reasons:', { skipNoOrg, skipExists, skipNoText, skipNoParts });

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('[chunks] failed:', err);
  process.exit(1);
});
