// routes/user.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const Org = require('../models/Org');
const EventCache = require('../models/EventCache');
const UserSyncState = require('../models/UserSyncState');

const ensureUserFreshToken = require('../middleware/ensureUserFreshToken');
const { getCalendarRange } = require('../utils/graph');

const { annotateEventsWithTranscripts, getTranscript } = require('../utils/transcripts');

const Transcript = require('../models/Transcript');
const { vttToText } = require('../utils/vtt');
const { generateMeetingSummary } = require('../utils/openaiSummary');

// helper windows
function past30DaysIncludingToday() {
  const now = new Date();

  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const start = new Date(now);
  start.setDate(now.getDate() - 29);
  start.setHours(0, 0, 0, 0);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function next3DaysIncludingTomorrow() {
  const now = new Date();

  const start = new Date(now);
  start.setDate(now.getDate() + 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 2);
  end.setHours(23, 59, 59, 999);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

async function getEventParticipants(accessToken, eventId) {
  if (!eventId) return [];

  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id,organizer,attendees`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }

  if (!r.ok) return [];

  const emails = [];
  const orgEmail = j?.organizer?.emailAddress?.address;
  if (orgEmail) emails.push(orgEmail);

  const atts = Array.isArray(j?.attendees) ? j.attendees : [];
  for (const a of atts) {
    const em = a?.emailAddress?.address;
    if (em) emails.push(em);
  }

  return [...new Set(emails.map(e => String(e).toLowerCase().trim()).filter(Boolean))];
}

// "karthikvj@suntecsbs.com" vs "karthikvj@suntecgroup.com"
function sameMailbox(a, b) {
  if (!a || !b) return false;
  const A = String(a).toLowerCase().trim();
  const B = String(b).toLowerCase().trim();
  if (A === B) return true;
  return A.split('@')[0] === B.split('@')[0];
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function clampDate(d) {
  const x = new Date(d);
  if (!Number.isFinite(x.getTime())) return null;
  return x;
}

// Merge overlapping/adjacent ranges to avoid repeated Graph calls
function mergeRanges(ranges) {
  const clean = ranges
    .map(r => ({ start: clampDate(r.start), end: clampDate(r.end) }))
    .filter(r => r.start && r.end && r.start <= r.end)
    .sort((a, b) => a.start - b.start);

  if (!clean.length) return [];

  const out = [clean[0]];
  for (let i = 1; i < clean.length; i++) {
    const prev = out[out.length - 1];
    const cur = clean[i];

    // if overlapping or adjacent (within 1 minute), merge
    if (cur.start.getTime() <= prev.end.getTime() + 60 * 1000) {
      prev.end = new Date(Math.max(prev.end.getTime(), cur.end.getTime()));
    } else {
      out.push(cur);
    }
  }
  return out;
}

async function upsertTranscriptEventsToCache({
  accessToken,
  orgId,
  userEmail,
  rangeStart,
  rangeEnd,
  annotateEventsWithTranscripts,
  getCalendarRange,
  maxChecks = 80,
  concurrency = 4,
}) {
  // 1) Fetch events metadata
  const list = await getCalendarRange(accessToken, {
    startDateTime: rangeStart.toISOString(),
    endDateTime: rangeEnd.toISOString(),
    top: 75,
    max: 300,
  });

  const events = Array.isArray(list) ? list : [];

  // 2) Candidates: online meetings only
  const candidates = events.filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));

  // 3) Annotate transcript existence (expensive)
  const annotated = await annotateEventsWithTranscripts(accessToken, candidates, {
    maxChecks,
    concurrency,
  });

  const transcriptEvents = (annotated || []).filter(ev => ev._hasTranscript && ev._transcripts?.length);

  // 4) Upsert into EventCache (only transcript events)
  if (transcriptEvents.length) {
    const bulk = EventCache.collection.initializeUnorderedBulkOp();
    let ops = 0;

    for (const ev of transcriptEvents) {
      const emails = [];

      const orgEmail = ev.organizer?.emailAddress?.address;
      if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());

      const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
      for (const a of atts) {
        const em = a?.emailAddress?.address;
        if (em) emails.push(String(em).toLowerCase().trim());
      }

      const uniqEmails = [...new Set(emails.filter(Boolean))];

      bulk
        .find({ orgId, userEmail, eventId: String(ev.id) })
        .upsert()
        .updateOne({
          $set: {
            orgId,
            userEmail,
            eventId: String(ev.id),

            subject: ev.subject || '',
            startDateTime: ev.start?.dateTime || '',
            endDateTime: ev.end?.dateTime || '',
            location: ev.location?.displayName || '',

            organizerEmail: String(orgEmail || '').toLowerCase().trim(),
            attendeeEmails: uniqEmails,

            hasTranscript: true,
            transcripts: (ev._transcripts || []).map(t => ({
              meetingId: String(t.meetingId || ''),
              transcriptId: String(t.id || ''),
            })),

            syncedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        });

      ops++;
    }

    if (ops > 0) await bulk.execute();
  }

  return { transcriptEventsCount: transcriptEvents.length };
}


// GET /user/login
router.get('/login', (req, res) => {
  res.render('user/login', { title: 'User login' });
});

// POST /user/login (store org context in session, then start O365 via /auth)
router.post('/login', async (req, res, next) => {
  try {
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (!slug) return res.status(400).send('Slug is required.');

    const org = await Org.findOne({ slug });
    if (!org) return res.status(404).send('Org not found.');

    req.session.joinOrgId = String(org._id);

    req.session.save((err) => {
      if (err) return next(err);
      return res.redirect('/auth/office365');
    });
  } catch (e) {
    next(e);
  }
});

// User homepage (protected)
function requireUser(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user?.email && req.user?.org) return next();
  return res.redirect('/user/login');
}

router.get('/home', requireUser, (req, res) => {
  res.render('user/home', {
    title: 'User Home',
    user: req.user,
    org: req.user.org,
  });
});

// GET /user/calendar (cached transcript-events for last N days, with optional refresh)
// router.get('/calendar', requireUser, ensureUserFreshToken, async (req, res) => {
//   let error = null;

//   const tokens = res.locals.userTokens;
//   const accessToken = (tokens?.access_token || '').trim();

//   const orgId = req.user.org?._id;
//   const me = String(req.user.email || '').toLowerCase().trim();

//   const PAST_DAYS = Math.max(1, Number(req.query.pastDays || 30));

//   const CACHE_FRESH_MS = 6 * 60 * 60 * 1000; // 6 hours
//   const forceRefresh = String(req.query.refresh || '') === '1';

//   try {
//     if (!accessToken) {
//       error = 'No access token available. Please sign in again.';
//       throw new Error(error);
//     }

//     const now = new Date();

//     const pastStart = new Date(now);
//     pastStart.setDate(now.getDate() - (PAST_DAYS - 1));
//     pastStart.setHours(0, 0, 0, 0);

//     const pastEnd = new Date(now);
//     pastEnd.setHours(23, 59, 59, 999);

//     // 1) Serve from cache if fresh
//     const lastCached = await EventCache.findOne({ orgId, userEmail: me })
//       .sort({ syncedAt: -1 })
//       .select({ syncedAt: 1 })
//       .lean();

//     const isFresh =
//       !!lastCached?.syncedAt &&
//       (Date.now() - new Date(lastCached.syncedAt).getTime()) < CACHE_FRESH_MS;

//     if (!forceRefresh && isFresh) {
//       const cached = await EventCache.find({
//         orgId,
//         userEmail: me,
//         hasTranscript: true,
//       })
//         .sort({ startDateTime: -1 })
//         .limit(400)
//         .lean();

//       const prevEvents = cached.filter(e => {
//         const t = Date.parse(e.startDateTime || '');
//         return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
//       });

//       return res.render('user/calendar', {
//         title: 'Meetings with transcripts',
//         user: req.user,
//         org: req.user.org,
//         activeNav: 'calendar',
//         prevEvents,
//         error: null,
//         cachedOnly: true,
//         cacheFresh: true,
//         pastDays: PAST_DAYS,
//         forceRefresh: false,
//         lastSyncedAt: lastCached?.syncedAt || null,
//       });
//     }

//     // 2) Refresh from Graph
//     const pastList = await getCalendarRange(accessToken, {
//       startDateTime: pastStart.toISOString(),
//       endDateTime: pastEnd.toISOString(),
//       top: 75,
//       max: 300,
//     });

//     const events = Array.isArray(pastList) ? pastList : [];

//     const candidates = events.filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));

//     // ✅ check newest meetings first (so maxChecks covers latest days)
//     const candidatesSorted = candidates
//       .slice()
//       .sort((a, b) => Date.parse(b?.start?.dateTime || '') - Date.parse(a?.start?.dateTime || ''));

//     const annotated = await annotateEventsWithTranscripts(accessToken, candidatesSorted, {
//       maxChecks: 300,
//       concurrency: 4,
//     });


//     const transcriptEvents = (annotated || []).filter(ev => ev._hasTranscript && ev._transcripts?.length);

//     if (transcriptEvents.length) {
//       const bulk = EventCache.collection.initializeUnorderedBulkOp();
//       let ops = 0;

//       for (const ev of transcriptEvents) {
//         const emails = [];

//         const orgEmail = ev.organizer?.emailAddress?.address;
//         if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());

//         const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
//         for (const a of atts) {
//           const em = a?.emailAddress?.address;
//           if (em) emails.push(String(em).toLowerCase().trim());
//         }

//         const uniqEmails = [...new Set(emails.filter(Boolean))];

//         bulk
//           .find({ orgId, userEmail: me, eventId: String(ev.id) })
//           .upsert()
//           .updateOne({
//             $set: {
//               orgId,
//               userEmail: me,
//               eventId: String(ev.id),

//               subject: ev.subject || '',
//               startDateTime: ev.start?.dateTime || '',
//               endDateTime: ev.end?.dateTime || '',
//               location: ev.location?.displayName || '',

//               organizerEmail: String(orgEmail || '').toLowerCase().trim(),
//               attendeeEmails: uniqEmails,

//               hasTranscript: true,
//               transcripts: (ev._transcripts || []).map(t => ({
//                 meetingId: String(t.meetingId || ''),
//                 transcriptId: String(t.id || ''),
//               })),

//               syncedAt: new Date(),
//             },
//             $setOnInsert: { createdAt: new Date() },
//           });

//         ops++;
//       }

//       if (ops > 0) await bulk.execute();
//     }

//     const prevEvents = transcriptEvents
//       .filter(ev => {
//         const t = Date.parse(ev.start?.dateTime || '');
//         return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
//       })
//       .sort((a, b) => Date.parse(b.start?.dateTime || '') - Date.parse(a.start?.dateTime || ''));

//     const lastSyncedAt = new Date();

//     return res.render('user/calendar', {
//       title: 'Meetings with transcripts',
//       user: req.user,
//       org: req.user.org,
//       activeNav: 'calendar',
//       prevEvents,
//       error: null,
//       cachedOnly: true,
//       cacheFresh: false,
//       pastDays: PAST_DAYS,
//       forceRefresh: true,
//       lastSyncedAt,
//     });
//   } catch (e) {
//     error = error || e.message || String(e);
//   }

//   return res.render('user/calendar', {
//     title: 'Meetings with transcripts',
//     user: req.user,
//     org: req.user.org,
//     activeNav: 'calendar',
//     prevEvents: [],
//     error,
//     cachedOnly: true,
//     cacheFresh: false,
//     pastDays: Number(req.query.pastDays || 30),
//     forceRefresh: String(req.query.refresh || '') === '1',
//     lastSyncedAt: null,
//   });
// });
// GET /user/calendar (incremental sync + backfill strategy)
// router.get('/calendar', requireUser, ensureUserFreshToken, async (req, res) => {
//   let error = null;

//   const tokens = res.locals.userTokens;
//   const accessToken = (tokens?.access_token || '').trim();

//   const orgId = req.user.org?._id;
//   const me = String(req.user.email || '').toLowerCase().trim();

//   const PAST_DAYS = Math.max(1, Number(req.query.pastDays || 30));
//   const forceRefresh = String(req.query.refresh || '') === '1';

//   // Strategy knobs (tune later)
//   const RECENT_DAYS = 10;              // always recheck these days
//   const BACKFILL_DAYS = 90;            // how far back to sweep for forwarded invites
//   const BACKFILL_EVERY_HOURS = 24;     // how often to do older sweep

//   // For performance: transcript check caps per range
//   const MAXCHECKS_RECENT = 120;
//   const MAXCHECKS_OTHER = 80;
//   const CONCURRENCY = 4;

//   try {
//     if (!accessToken) throw new Error('No access token available. Please sign in again.');

//     // Requested window
//     const now = new Date();
//     const requestedStart = startOfDay(addDays(now, -(PAST_DAYS - 1)));
//     const requestedEnd = endOfDay(now);

//     // Load/create sync state
//     let state = await UserSyncState.findOne({ orgId, userEmail: me });
//     if (!state) state = await UserSyncState.create({ orgId, userEmail: me });

//     const syncedFrom = state.syncedFrom ? startOfDay(state.syncedFrom) : null;
//     const syncedTo = state.syncedTo ? endOfDay(state.syncedTo) : null;

//     const ranges = [];

//     // 1) If first run or forced refresh: we still don’t want full cost always.
//     // We’ll sync the requested window, but in slices:
//     if (!syncedFrom || !syncedTo) {
//       ranges.push({ start: requestedStart, end: requestedEnd });
//     } else {
//       // 2) Extend-only sync (missing left/right)
//       if (requestedStart < syncedFrom) {
//         // missing-left
//         ranges.push({ start: requestedStart, end: addDays(syncedFrom, 1) }); // +1 day overlap
//       }
//       if (requestedEnd > syncedTo) {
//         // missing-right
//         ranges.push({ start: addDays(syncedTo, -1), end: requestedEnd }); // -1 day overlap
//       }

//       // 3) Always recheck recent window (late transcripts + edits)
//       const recentStart = startOfDay(addDays(now, -(RECENT_DAYS - 1)));
//       ranges.push({ start: recentStart, end: requestedEnd });

//       // 4) Backfill sweep (catches forwarded/retro invites) - only sometimes
//       const lastBackfillAt = state.lastBackfillAt ? new Date(state.lastBackfillAt) : null;
//       const backfillDue =
//         forceRefresh ||
//         !lastBackfillAt ||
//         (Date.now() - lastBackfillAt.getTime()) > BACKFILL_EVERY_HOURS * 60 * 60 * 1000;

//       if (backfillDue) {
//         const backfillStart = startOfDay(addDays(now, -(BACKFILL_DAYS - 1)));
//         const backfillEnd = endOfDay(addDays(now, -RECENT_DAYS)); // older portion only
//         if (backfillStart < backfillEnd) {
//           ranges.push({ start: backfillStart, end: backfillEnd });
//         }
//       }
//     }

//     // If user explicitly refreshes, also ensure recent recheck is included even on first sync
//     if (forceRefresh) {
//       const recentStart = startOfDay(addDays(now, -(RECENT_DAYS - 1)));
//       ranges.push({ start: recentStart, end: requestedEnd });
//     }

//     const merged = mergeRanges(ranges);

//     // Run sync ranges (Graph + annotate + upsert)
//     for (const r of merged) {
//       const isRecentish = r.end.getTime() >= startOfDay(addDays(now, -(RECENT_DAYS - 1))).getTime();

//       await upsertTranscriptEventsToCache({
//         accessToken,
//         orgId,
//         userEmail: me,
//         rangeStart: r.start,
//         rangeEnd: r.end,
//         annotateEventsWithTranscripts,
//         getCalendarRange,
//         maxChecks: isRecentish ? MAXCHECKS_RECENT : MAXCHECKS_OTHER,
//         concurrency: CONCURRENCY,
//       });
//     }

//     // Update sync state coverage
//     const newFrom = syncedFrom ? new Date(Math.min(syncedFrom.getTime(), requestedStart.getTime())) : requestedStart;
//     const newTo = syncedTo ? new Date(Math.max(syncedTo.getTime(), requestedEnd.getTime())) : requestedEnd;

//     const update = {
//       syncedFrom: newFrom,
//       syncedTo: newTo,
//       lastSyncedAt: new Date(),
//     };

//     // If we included the backfill range, set lastBackfillAt
//     const didBackfill = merged.some(r => r.start <= startOfDay(addDays(now, -(BACKFILL_DAYS - 1))));
//     if (didBackfill) update.lastBackfillAt = new Date();

//     await UserSyncState.updateOne({ _id: state._id }, { $set: update });

//     // Serve from cache (within requested window)
//     const cached = await EventCache.find({
//       orgId,
//       userEmail: me,
//       hasTranscript: true,
//     })
//       .sort({ startDateTime: -1 })
//       .limit(600)
//       .lean();

//     const prevEvents = cached.filter(e => {
//       const t = Date.parse(e.startDateTime || '');
//       return Number.isFinite(t) && t >= requestedStart.getTime() && t <= requestedEnd.getTime();
//     });

//     const freshState = await UserSyncState.findOne({ orgId, userEmail: me }).lean();

//     return res.render('user/calendar', {
//       title: 'Meetings with transcripts',
//       user: req.user,
//       org: req.user.org,
//       activeNav: 'calendar',
//       prevEvents,
//       error: null,

//       // UI helpers
//       cachedOnly: true,
//       cacheFresh: false,
//       pastDays: PAST_DAYS,
//       forceRefresh,
//       lastSyncedAt: freshState?.lastSyncedAt || null,
//       syncedFrom: freshState?.syncedFrom || null,
//       syncedTo: freshState?.syncedTo || null,
//       lastBackfillAt: freshState?.lastBackfillAt || null,
//     });
//   } catch (e) {
//     error = e.message || String(e);
//   }

//   return res.render('user/calendar', {
//     title: 'Meetings with transcripts',
//     user: req.user,
//     org: req.user.org,
//     activeNav: 'calendar',
//     prevEvents: [],
//     error,
//     cachedOnly: true,
//     cacheFresh: false,
//     pastDays: Number(req.query.pastDays || 30),
//     forceRefresh: String(req.query.refresh || '') === '1',
//     lastSyncedAt: null,
//     syncedFrom: null,
//     syncedTo: null,
//     lastBackfillAt: null,
//   });
// });
// GET /user/calendar
// ✅ Default: instant load from EventCache only
// ✅ Only if ?refresh=1 => call Graph + update cache
router.get('/calendar', requireUser, ensureUserFreshToken, async (req, res) => {
  let error = null;

  const orgId = req.user.org?._id;
  const me = String(req.user.email || '').toLowerCase().trim();

  const PAST_DAYS = Math.max(1, Number(req.query.pastDays || 30));
  const doRefresh = String(req.query.refresh || '') === '1';

  // tokens only needed when we refresh
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  // window boundaries
  const now = new Date();
  const pastStart = new Date(now);
  pastStart.setDate(now.getDate() - (PAST_DAYS - 1));
  pastStart.setHours(0, 0, 0, 0);

  const pastEnd = new Date(now);
  pastEnd.setHours(23, 59, 59, 999);

  try {
    // --------------------------
    // 0) ALWAYS read cache first
    // --------------------------
    const cachedAll = await EventCache.find({
      orgId,
      userEmail: me,
      hasTranscript: true,
    })
      .sort({ startDateTime: -1 })
      .limit(500)
      .lean();

    const prevEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
    });

    const lastCached = await EventCache.findOne({ orgId, userEmail: me })
      .sort({ syncedAt: -1 })
      .select({ syncedAt: 1 })
      .lean();

    // ---------------------------------------------------------
    // 1) If NOT refresh => render immediately (instant open)
    // ---------------------------------------------------------
    if (!doRefresh) {
      return res.render('user/calendar', {
        title: 'Meetings with transcripts',
        user: req.user,
        org: req.user.org,
        activeNav: 'calendar',
        prevEvents: prevEventsFromCache,
        error: null,
        pastDays: PAST_DAYS,
        lastSyncedAt: lastCached?.syncedAt || null,
        isRefreshing: false, // UI hint
      });
    }

    // ---------------------------------------------------------
    // 2) Refresh requested => call Graph + update cache
    // ---------------------------------------------------------
    if (!accessToken) {
      error = 'No access token available. Please sign in again.';
      return res.render('user/calendar', {
        title: 'Meetings with transcripts',
        user: req.user,
        org: req.user.org,
        activeNav: 'calendar',
        prevEvents: prevEventsFromCache,
        error,
        pastDays: PAST_DAYS,
        lastSyncedAt: lastCached?.syncedAt || null,
        isRefreshing: false,
      });
    }

    // Fetch events (metadata)
    const pastList = await getCalendarRange(accessToken, {
      startDateTime: pastStart.toISOString(),
      endDateTime: pastEnd.toISOString(),
      top: 75,
      max: 300,
    });

    const events = Array.isArray(pastList) ? pastList : [];

    // Only online candidates
    const candidates = events.filter(ev => !!(ev?.isOnlineMeeting || ev?.onlineMeeting || ev?.onlineMeetingUrl));

    // Check transcript existence only for candidates
    const annotated = await annotateEventsWithTranscripts(accessToken, candidates, {
      maxChecks: 60,
      concurrency: 4,
    });

    const transcriptEvents = (annotated || []).filter(ev => ev._hasTranscript && ev._transcripts?.length);

    // Bulk upsert cache
    if (transcriptEvents.length) {
      const bulk = EventCache.collection.initializeUnorderedBulkOp();
      let ops = 0;

      for (const ev of transcriptEvents) {
        const emails = [];

        const orgEmail = ev.organizer?.emailAddress?.address;
        if (orgEmail) emails.push(String(orgEmail).toLowerCase().trim());

        const atts = Array.isArray(ev.attendees) ? ev.attendees : [];
        for (const a of atts) {
          const em = a?.emailAddress?.address;
          if (em) emails.push(String(em).toLowerCase().trim());
        }

        const uniqEmails = [...new Set(emails.filter(Boolean))];

        bulk.find({ orgId, userEmail: me, eventId: String(ev.id) }).upsert().updateOne({
          $set: {
            orgId,
            userEmail: me,
            eventId: String(ev.id),

            subject: ev.subject || '',
            startDateTime: ev.start?.dateTime || '',
            endDateTime: ev.end?.dateTime || '',
            location: ev.location?.displayName || '',

            organizerEmail: String(orgEmail || '').toLowerCase().trim(),
            attendeeEmails: uniqEmails,

            hasTranscript: true,
            transcripts: (ev._transcripts || []).map(t => ({
              meetingId: String(t.meetingId || ''),
              transcriptId: String(t.id || ''),
            })),

            syncedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        });

        ops++;
      }

      if (ops > 0) await bulk.execute();
    }

    // ✅ After refresh, redirect to cache-only view (fast)
    return res.redirect(`/user/calendar?pastDays=${encodeURIComponent(PAST_DAYS)}`);
  } catch (e) {
    error = e.message || String(e);
    // even on error, still show cached results
    const cachedAll = await EventCache.find({
      orgId,
      userEmail: me,
      hasTranscript: true,
    })
      .sort({ startDateTime: -1 })
      .limit(500)
      .lean();

    const prevEventsFromCache = cachedAll.filter(e => {
      const t = Date.parse(e.startDateTime || '');
      return Number.isFinite(t) && t >= pastStart.getTime() && t <= pastEnd.getTime();
    });

    const lastCached = await EventCache.findOne({ orgId, userEmail: me })
      .sort({ syncedAt: -1 })
      .select({ syncedAt: 1 })
      .lean();

    return res.render('user/calendar', {
      title: 'Meetings with transcripts',
      user: req.user,
      org: req.user.org,
      activeNav: 'calendar',
      prevEvents: prevEventsFromCache,
      error,
      pastDays: PAST_DAYS,
      lastSyncedAt: lastCached?.syncedAt || null,
      isRefreshing: false,
      syncedFrom: null,
      syncedTo: null,
      lastBackfillAt: null,
    });
  }
});


router.get('/debug/transcript/:eventId', requireUser, ensureUserFreshToken, async (req, res) => {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  if (!accessToken) return res.status(401).send('No access token.');

  const eventId = req.params.eventId;

  try {
    const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id,subject,start,end,onlineMeeting,onlineMeetingUrl,isOnlineMeeting`;
    const ev = await (await require('node-fetch')(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })).json();

    const joinUrl = ev?.onlineMeeting?.joinUrl || ev?.onlineMeetingUrl || null;

    return res.json({
      eventId,
      subject: ev?.subject,
      start: ev?.start?.dateTime,
      end: ev?.end?.dateTime,
      joinUrl,
      isOnlineMeeting: ev?.isOnlineMeeting,
      onlineMeetingObj: ev?.onlineMeeting || null
    });
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// GET /user/transcript/ensure/:meetingId/:transcriptId
router.get(
  '/transcript/ensure/:meetingId/:transcriptId',
  requireUser,
  ensureUserFreshToken,
  async (req, res) => {

    const tokens = res.locals.userTokens;
    const accessToken = (tokens?.access_token || '').trim();
    if (!accessToken) return res.status(401).send('No access token.');

    const { meetingId, transcriptId } = req.params;
    const eventId = String(req.query.eventId || '').trim();
    const orgId = req.user.org?._id;

    const me = String(req.user.email || '').toLowerCase().trim();

    let doc = null;

    try {
      // ✅ MIGRATION-SAFE LOOKUP:
      // New key: (orgId, eventId, transcriptId)
      // Old key: (orgId, meetingId, transcriptId)
      doc = await Transcript.findOne({ orgId, eventId, transcriptId });
      if (!doc) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });

      // Create if missing
      if (!doc) {
        const vtt = await getTranscript(accessToken, meetingId, transcriptId, 'text/vtt');
        const text = vttToText(vtt);

        // Fetch participants for enrichment (not hard-auth gate)
        const participantEmails = await getEventParticipants(accessToken, eventId);

        // Optional log for alias mismatch
        if (participantEmails.length && !participantEmails.some(p => sameMailbox(p, me))) {
          console.warn('[transcript-access] email not in attendee list (alias likely):', me, participantEmails);
        }

        try {
          doc = await Transcript.create({
            orgId,
            eventId,
            meetingId,
            transcriptId,
            subject: req.query.subject || '',
            startDateTime: req.query.start || '',
            endDateTime: req.query.end || '',
            participantEmails,
            vtt,
            text,
            ai: { status: 'none' },
          });
        } catch (e) {
          if (e.code === 11000) {
            doc = await Transcript.findOne({ orgId, eventId, transcriptId });
            if (!doc) doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
          } else {
            throw e;
          }
        }
      }

      // Hard guard
      if (!doc) {
        return res.status(500).send('Transcript document could not be created or loaded.');
      }

      // Backfill participants if missing
      if (!doc.participantEmails || !doc.participantEmails.length) {
        const participantEmails = await getEventParticipants(accessToken, eventId);
        if (participantEmails.length) {
          await Transcript.updateOne({ _id: doc._id }, { $set: { participantEmails } });
          doc.participantEmails = participantEmails;
        }
      }

      // ✅ Access check:
      // We DO NOT hard-block based on attendee list because of alias/UPN mismatches.
      // If you want to hard-block later, do it by verifying /me identity (mail/proxyAddresses).
      const allowed = (doc.participantEmails || []).some(p => sameMailbox(p, me));
      if (doc.participantEmails?.length && !allowed) {
        console.warn('[transcript-access] mismatch; allowing via calendar visibility:', me, doc.participantEmails);
      }

      // If summary already done
      if (doc.ai?.status === 'done' && doc.ai?.summary) {
        return res.redirect(`/user/transcript/saved/${doc._id}`);
      }

      // Reset stale queued
      const now = Date.now();
      const queuedAt = doc.ai?.updatedAt ? new Date(doc.ai.updatedAt).getTime() : 0;
      const QUEUE_STALE_MS = 5 * 60 * 1000;

      if (doc.ai?.status === 'queued' && queuedAt && (now - queuedAt) > QUEUE_STALE_MS) {
        await Transcript.updateOne(
          { _id: doc._id },
          { $set: { 'ai.status': 'none', 'ai.error': 'stale queued reset', 'ai.updatedAt': new Date() } }
        );
        doc = await Transcript.findById(doc._id);
      }

      // Acquire lock
      await Transcript.updateOne(
        {
          _id: doc._id,
          $or: [
            { 'ai.status': { $in: ['none', 'error'] } },
            { 'ai.status': { $exists: false } },
          ],
        },
        { $set: { 'ai.status': 'queued', 'ai.updatedAt': new Date() } }
      );

      doc = await Transcript.findById(doc._id);

      // Generate summary
      if (doc.ai?.status === 'queued' && !doc.ai?.summary) {
        try {
          console.log('AI summary generating:', String(doc._id), 'len:', (doc.text || '').length);

          const { model, summary } = await generateMeetingSummary({
            text: doc.text || '',
            subject: doc.subject || req.query.subject || '',
          });

          await Transcript.updateOne(
            { _id: doc._id },
            {
              $set: {
                'ai.status': 'done',
                'ai.model': model,
                'ai.summary': summary,
                'ai.error': '',
                'ai.createdAt': doc.ai?.createdAt || new Date(),
                'ai.updatedAt': new Date(),
              },
            }
          );
        } catch (err) {
          console.log('AI summary failed:', err);

          await Transcript.updateOne(
            { _id: doc._id },
            {
              $set: {
                'ai.status': 'error',
                'ai.error': err.message || String(err),
                'ai.updatedAt': new Date(),
              },
            }
          );
        }
      }

      return res.redirect(`/user/transcript/saved/${doc._id}`);
    } catch (e) {
      return res.status(500).send(e.message || String(e));
    }
  }
);

router.get('/transcript/saved/:id', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');

  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');

  return res.render('user/transcript_saved', {
    title: 'Saved Transcript',
    user: req.user,
    org: req.user.org,
    doc,
  });
});

router.get('/transcript/saved/:id/summary', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');
  if (String(doc.orgId) !== String(req.user.org?._id)) return res.status(403).send('Forbidden');

  return res.render('user/summary', {
    title: 'AI Summary',
    user: req.user,
    org: req.user.org,
    doc,
  });
});

module.exports = router;
