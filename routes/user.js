// routes/user.js
const express = require('express');
const router = express.Router();

const Org = require('../models/Org');
const EventCache = require('../models/EventCache');


const ensureUserFreshToken = require('../middleware/ensureUserFreshToken');
const { getCalendarRange } = require('../utils/graph');

const { annotateEventsWithTranscripts, getTranscript } = require('../utils/transcripts');

const Transcript = require('../models/Transcript');
const { vttToText } = require('../utils/vtt');
const { generateMeetingSummary } = require('../utils/openaiSummary');


// helper windows (no "today" overlap)
// helper windows
function past30DaysIncludingToday() {
  const now = new Date();

  // end = end of today
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  // start = start of day 14 days ago (today counts as day 15)
  const start = new Date(now);
  start.setDate(now.getDate() - 29);
  start.setHours(0, 0, 0, 0);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function next3DaysIncludingTomorrow() {
  const now = new Date();

  // start = start of tomorrow
  const start = new Date(now);
  start.setDate(now.getDate() + 1);
  start.setHours(0, 0, 0, 0);

  // end = end of day (tomorrow + 2 days) => 3 days total
  const end = new Date(start);
  end.setDate(start.getDate() + 2);
  end.setHours(23, 59, 59, 999);

  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
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

// GET /user/calendar (last 3 days + next 3 days)
router.get('/calendar', requireUser, ensureUserFreshToken, async (req, res) => {
  let error = null;
  let prevEvents = [];
  let nextEvents = [];

  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  try {
    if (!accessToken) {
      error = 'No access token available. Please sign in again.';
    } else {
      const past = past30DaysIncludingToday();
      const future = next3DaysIncludingTomorrow();

      const [pastList, futureList] = await Promise.all([
        getCalendarRange(accessToken, { ...past, top: 25 }),
        getCalendarRange(accessToken, { ...future, top: 25 }),
      ]);

      prevEvents = Array.isArray(pastList) ? pastList : [];
      prevEvents = prevEvents.reverse();
      nextEvents = Array.isArray(futureList) ? futureList : [];
  


      // ✅ annotate all past events; concurrency avoids slowness
      prevEvents = await annotateEventsWithTranscripts(accessToken, prevEvents, {
        maxChecks: 30,
        concurrency: 4,
      });

      const has = (prevEvents || []).filter(e => e._hasTranscript).length;

    }
  } catch (e) {
    error = e.message || String(e);
  }

  return res.render('user/calendar', {
    title: 'My Calendar',
    user: req.user,
    org: req.user.org,
    prevEvents,
    nextEvents,
    error,
  });
});

router.get('/debug/transcript/:eventId', requireUser, ensureUserFreshToken, async (req, res) => {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();

  if (!accessToken) return res.status(401).send('No access token.');

  const eventId = req.params.eventId;

  try {
    // 1) fetch event from Graph
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


// GET /user/transcript/view/:meetingId/:transcriptId
router.get('/transcript/ensure/:meetingId/:transcriptId', requireUser, ensureUserFreshToken, async (req, res) => {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();
  if (!accessToken) return res.status(401).send('No access token. Please sign in again.');

  const { meetingId, transcriptId } = req.params;
  const orgId = req.user.org?._id;

  try {
    // 1) Find or create transcript doc (once)
    let doc = await Transcript.findOne({ orgId, meetingId, transcriptId });

    if (!doc) {
      const vtt = await getTranscript(accessToken, meetingId, transcriptId, 'text/vtt');
      const text = vttToText(vtt);

      try {
        doc = await Transcript.create({
          orgId,
          meetingId,
          transcriptId,
          subject: req.query.subject || '',
          startDateTime: req.query.start || '',
          endDateTime: req.query.end || '',
          vtt,
          text,
          ai: { status: 'none' },
        });
      } catch (e) {
        if (e.code === 11000) {
          doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
        } else {
          throw e;
        }
      }
    }

    // 2) If summary already done, just show it
    if (doc.ai?.status === 'done' && doc.ai?.summary) {
      return res.redirect(`/user/transcript/saved/${doc._id}`);
    }

    // 3) If queued too long, reset (prevents permanent stuck)
    const now = Date.now();
    const queuedAt = doc.ai?.updatedAt ? new Date(doc.ai.updatedAt).getTime() : 0;
    const QUEUE_STALE_MS = 5 * 60 * 1000; // 5 mins is enough

    if (doc.ai?.status === 'queued' && queuedAt && (now - queuedAt) > QUEUE_STALE_MS) {
      await Transcript.updateOne(
        { _id: doc._id },
        { $set: { 'ai.status': 'none', 'ai.error': 'stale queued reset', 'ai.updatedAt': new Date() } }
      );
      doc = await Transcript.findById(doc._id);
    }

    // 4) Acquire lock if needed (none/error -> queued)
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

    // reload latest
    doc = await Transcript.findById(doc._id);

    // 5) If queued and summary empty, generate (this covers BOTH fresh and previously queued)
    if (doc.ai?.status === 'queued' && !doc.ai?.summary) {
      try {
        console.log('AI summary generating for transcript:', String(doc._id), 'len:', (doc.text || '').length);

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
        console.log('AI summary failed for transcript:', String(doc._id), err);

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
});


router.get('/debug/onlineMeetings', requireUser, ensureUserFreshToken, async (req, res) => {
  const accessToken = (res.locals.userTokens?.access_token || '').trim();
  const url = 'https://graph.microsoft.com/beta/me/onlineMeetings?$top=1';
  const fetch = require('node-fetch');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const txt = await r.text();
  res.status(r.status).send(txt);
});

// Ensure transcript is saved + AI summary created once
router.get('/transcript/ensure/:meetingId/:transcriptId', requireUser, ensureUserFreshToken, async (req, res) => {
  const tokens = res.locals.userTokens;
  const accessToken = (tokens?.access_token || '').trim();
  if (!accessToken) return res.status(401).send('No access token. Please sign in again.');

  const { meetingId, transcriptId } = req.params;
  const orgId = req.user.org?._id;

  try {
    // 1) Find existing transcript doc
    let doc = await Transcript.findOne({ orgId, meetingId, transcriptId });

    // 2) If not exists, fetch from Graph and create (once)
    if (!doc) {
      const vtt = await getTranscript(accessToken, meetingId, transcriptId, 'text/vtt');
      const text = vttToText(vtt);

      try {
        doc = await Transcript.create({
          orgId,
          meetingId,
          transcriptId,
          subject: req.query.subject || '',
          startDateTime: req.query.start || '',
          endDateTime: req.query.end || '',
          vtt,
          text,
        });
      } catch (e) {
        // race condition: someone else created it first
        if (e.code === 11000) {
          doc = await Transcript.findOne({ orgId, meetingId, transcriptId });
        } else {
          throw e;
        }
      }
    }

    const now = Date.now();
    const queuedAt = doc.ai?.updatedAt ? new Date(doc.ai.updatedAt).getTime() : 0;
    const QUEUE_STALE_MS = 10 * 60 * 1000;

    if (doc.ai?.status === 'queued' && queuedAt && (now - queuedAt) > QUEUE_STALE_MS) {
      await Transcript.updateOne(
        { _id: doc._id },
        { $set: { 'ai.status': 'none', 'ai.error': 'stale queued reset', 'ai.updatedAt': new Date() } }
      );
      doc = await Transcript.findById(doc._id);
    }

    // 3) Ensure AI summary exists (once)
    if (!doc.ai || doc.ai.status === 'none') {
      // mark queued to prevent duplicate summary generation
      await Transcript.updateOne(
        { _id: doc._id, 'ai.status': { $in: ['none', undefined] } },
        { $set: { 'ai.status': 'queued', 'ai.updatedAt': new Date() } }
      );

      // reload to check state
      doc = await Transcript.findById(doc._id);

      // only the first request that successfully set queued should generate
      if (doc.ai.status === 'queued' && !doc.ai.summary) {
        try {
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
                'ai.createdAt': doc.ai.createdAt || new Date(),
                'ai.updatedAt': new Date(),
              },
            }
          );
        } catch (err) {
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
    }

    // redirect to saved transcript view page
    return res.redirect(`/user/transcript/saved/${doc._id}`);
  } catch (e) {
    return res.status(500).send(e.message || String(e));
  }
});

router.get('/transcript/saved/:id', requireUser, async (req, res) => {
  const doc = await Transcript.findById(req.params.id);
  if (!doc) return res.status(404).send('Transcript not found');

  // org isolation
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
