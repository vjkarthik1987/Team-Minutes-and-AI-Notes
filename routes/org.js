const express = require('express');
const router = express.Router();

const Org = require('../models/Org');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const UserLoginLog = require('../models/UserLoginLog');
const ErrorLog = require('../models/ErrorLog');
const EventCache = require('../models/EventCache');
const Transcript = require('../models/Transcript');
const UserSyncState = require('../models/UserSyncState');
const MeetingThread = require('../models/MeetingThread');
const PageVisitLog = require('../models/PageVisitLog');
const IssueReport = require('../models/IssueReport');
const IntelligenceCache = require('../models/IntelligenceCache');
const AssistantMapping = require('../models/AssistantMapping');
const AssistantNote = require('../models/AssistantNote');
const MeetingLink = require('../models/MeetingLink');
const { resetFailedTranscriptJobs } = require('../utils/jobRetry');

// auth guard (org must be logged in)
function requireOrg(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/auth/login');
}

function roleLabel(role) {
  return ({ general_user: 'General User', ceo: 'CEO', super_admin: 'Super Admin' }[role] || role || '-');
}

function allowedRole(raw) {
  const allowedRoles = ['ceo', 'general_user', 'super_admin', 'admin', 'org_admin', 'superadmin', 'user', 'member'];
  return allowedRoles.includes(raw) ? User.normalizeRole(raw) : 'general_user';
}

function truthy(v) {
  return ['true', 'yes', '1', 'y', 'on'].includes(String(v || '').trim().toLowerCase());
}

function cleanEmail(email) {
  return String(email || '').toLowerCase().trim();
}

router.use((req, res, next) => {
  const p = String(req.path || '');
  res.locals.activeOrgNav = p === '/' ? 'dashboard'
    : p.startsWith('/users/bulk') ? 'bulk'
    : p.startsWith('/users') ? 'users'
    : p.startsWith('/activity') ? 'activity'
    : p.startsWith('/login-logs') ? 'loginLogs'
    : p.startsWith('/usage') ? 'usage'
    : p.startsWith('/issues') ? 'issues'
    : p.startsWith('/assistants') ? 'assistants'
    : p.startsWith('/diagnostics') ? 'diagnostics'
    : p.startsWith('/health') ? 'health'
    : p.startsWith('/errors') ? 'errors'
    : p.startsWith('/settings') ? 'settings'
    : '';
  next();
});

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
}

function orgUserTemplate(org) {
  const domain = (org.allowedDomains && org.allowedDomains[0]) || String(org.loginEmail || '').split('@')[1] || 'company.com';
  const rows = [
    ['name','email','role','status','department','designation','canAssignActions','canAssignFollowups','canViewAuditLog'],
    ['Karthik VJ', `karthik@${domain}`, 'general_user', 'active', 'CEO Office', 'Strategy', 'true', 'true', 'false'],
    ['Anu Menon', `anu@${domain}`, 'ceo', 'active', 'Talent', 'Function Head', 'false', 'false', 'false'],
  ];
  return rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function checkOrgDomain(org, email) {
  const domains = (org.allowedDomains || []).map(d => String(d || '').toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!domains.length) return true;
  const domain = String(email || '').split('@')[1] || '';
  return domains.includes(domain.toLowerCase());
}

// Backward-compatible redirect. Org/Admin login lives under /auth/login.
router.get('/login', (req, res) => res.redirect('/auth/login'));

// GET /org
router.get('/', requireOrg, async (req, res, next) => {
  try {
    const orgId = req.user._id;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [
      totalUsers,
      activeUsers,
      inactiveUsers,
      usersLoggedInWeek,
      meetingsCached,
      meetingsWithTranscript,
      summariesGenerated,
      threadsCreated,
      pageVisitsWeek,
      errorsOpen,
      openIssues,
      usersNeverLoggedIn,
      summariesReviewed,
      intelligenceUsed,
      recentActivity,
    ] = await Promise.all([
      User.countDocuments({ org: orgId }),
      User.countDocuments({ org: orgId, status: 'active' }),
      User.countDocuments({ org: orgId, status: 'inactive' }),
      UserLoginLog.distinct('userId', { orgId, status: 'success', loginAt: { $gte: sevenDaysAgo } }).then(x => x.filter(Boolean).length),
      EventCache.countDocuments({ orgId }),
      EventCache.countDocuments({ orgId, hasTranscript: true }),
      Transcript.countDocuments({ orgId, 'ai.summary': { $exists: true, $ne: '' } }),
      MeetingThread.countDocuments({ orgId }),
      PageVisitLog.countDocuments({ orgId, createdAt: { $gte: sevenDaysAgo } }),
      ErrorLog.countDocuments({ $and: [{ $or: [{ orgId }, { orgId: null }] }, { $or: [{ resolvedAt: null }, { resolvedAt: { $exists: false } }] }] }),
      IssueReport.countDocuments({ orgId, status: { $in: ['open','reviewing'] } }),
      User.countDocuments({ org: orgId, $or: [{ lastLoginAt:null }, { lastLoginAt: { $exists:false } }] }),
      Transcript.countDocuments({ orgId, 'ai.reviewed': true }),
      IntelligenceCache.countDocuments({ orgId }),
      PageVisitLog.find({ orgId }).sort({ createdAt: -1 }).limit(8).lean(),
    ]);
    res.render('org/index', {
      title: 'Org Dashboard',
      org: req.user,
      metrics: { totalUsers, activeUsers, inactiveUsers, usersLoggedInWeek, meetingsCached, meetingsWithTranscript, summariesGenerated, threadsCreated, pageVisitsWeek, errorsOpen, openIssues, usersNeverLoggedIn, summariesReviewed, intelligenceUsed },
      launchChecklist: { usersAdded: totalUsers > 0, loginWorking: usersLoggedInWeek > 0, meetingsCached: meetingsCached > 0, transcriptsDetected: meetingsWithTranscript > 0, summariesGenerated: summariesGenerated > 0, threadsCreated: threadsCreated > 0, activityLogging: pageVisitsWeek > 0, errorVisibility: errorsOpen >= 0, issueReporting: openIssues >= 0 },
      recentActivity,
    });
  } catch (e) { next(e); }
});

// GET /org/usage

router.get('/usage', requireOrg, async (req, res, next) => {
  try {
    const orgId = req.user._id;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      activeUsersWeek,
      neverLoggedIn,
      refreshUsers,
      summariesGenerated,
      summariesReviewed,
      threadsCreated,
      intelligenceUsed,
      topUsers,
      topPages,
    ] = await Promise.all([
      UserLoginLog.distinct('userId', { orgId, status:'success', loginAt:{ $gte: sevenDaysAgo } }).then(x => x.filter(Boolean).length),
      User.countDocuments({ org: orgId, $or: [{ lastLoginAt:null }, { lastLoginAt:{ $exists:false } }] }),
      EventCache.distinct('userEmail', { orgId, syncedAt:{ $gte: thirtyDaysAgo } }).then(x => x.filter(Boolean).length),
      Transcript.countDocuments({ orgId, 'ai.summary': { $exists:true, $ne:'' } }),
      Transcript.countDocuments({ orgId, 'ai.reviewed': true }),
      MeetingThread.countDocuments({ orgId }),
      IntelligenceCache.countDocuments({ orgId }),
      PageVisitLog.aggregate([{ $match:{ orgId, createdAt:{ $gte: sevenDaysAgo } } }, { $group:{ _id:'$actorEmail', visits:{ $sum:1 }, last:{ $max:'$createdAt' } } }, { $sort:{ visits:-1 } }, { $limit:12 }]),
      PageVisitLog.aggregate([{ $match:{ orgId, createdAt:{ $gte: sevenDaysAgo } } }, { $group:{ _id:'$path', visits:{ $sum:1 } } }, { $sort:{ visits:-1 } }, { $limit:12 }]),
    ]);
    res.render('org/usage', { title:'Usage dashboard', org:req.user, metrics:{ activeUsersWeek, neverLoggedIn, refreshUsers, summariesGenerated, summariesReviewed, threadsCreated, intelligenceUsed }, topUsers, topPages });
  } catch (e) { next(e); }
});

// GET /org/assistants - central Assistant Desk mappings
router.get('/assistants', requireOrg, async (req, res, next) => {
  try {
    const [users, mappings, recentNotes] = await Promise.all([
      User.find({ org:req.user._id, status:'active' }).select({ name:1, email:1, role:1, department:1, designation:1 }).sort({ name:1, email:1 }).lean(),
      AssistantMapping.find({ orgId:req.user._id, active:true }).sort({ principalName:1, assistantName:1 }).limit(400).lean(),
      AssistantNote.find({ orgId:req.user._id }).sort({ createdAt:-1 }).limit(25).lean(),
    ]);
    res.render('org/assistants', { title:'Assistant Desk mappings', org:req.user, users, mappings, recentNotes });
  } catch(e) { next(e); }
});

router.post('/assistants', requireOrg, async (req, res, next) => {
  try {
    const principalEmail = cleanEmail(req.body.principalEmail);
    const assistantEmail = cleanEmail(req.body.assistantEmail);
    if (!principalEmail || !assistantEmail || principalEmail === assistantEmail) return res.status(400).send('Choose different principal and assistant users.');
    const [principal, assistant] = await Promise.all([
      User.findOne({ org:req.user._id, email:principalEmail }).select({ _id:1, name:1, email:1 }).lean(),
      User.findOne({ org:req.user._id, email:assistantEmail }).select({ _id:1, name:1, email:1 }).lean(),
    ]);
    if (!principal || !assistant) return res.status(404).send('Principal and assistant must both exist as active users in this org.');
    const permissions = {
      canAddGeneralNotes: truthy(req.body.canAddGeneralNotes || 'true'),
      canAddMeetingNotes: truthy(req.body.canAddMeetingNotes || 'true'),
      canAddThreadNotes: truthy(req.body.canAddThreadNotes || 'true'),
      canAddQuestions: truthy(req.body.canAddQuestions || 'true'),
      canAddFollowups: truthy(req.body.canAddFollowups || 'true'),
      canAddRisks: truthy(req.body.canAddRisks || 'true'),
      canSeeOwnNotes: true,
    };
    await AssistantMapping.findOneAndUpdate(
      { orgId:req.user._id, principalEmail, assistantEmail },
      { $set:{ principalUserId:principal._id, principalEmail, principalName:principal.name || principalEmail, assistantUserId:assistant._id, assistantEmail, assistantName:assistant.name || assistantEmail, permissions, source:'org_admin', active:true, removedAt:null, removedByEmail:'', createdByEmail:req.user.loginEmail || '' } },
      { upsert:true, new:true, setDefaultsOnInsert:true }
    );
    await User.updateOne({ _id:principal._id }, { $pull:{ collaborators:{ email:assistantEmail } } });
    await User.updateOne({ _id:principal._id }, { $push:{ collaborators:{ email:assistantEmail, name:assistant.name || assistantEmail, role:'assistant', canAddContext:true, canAddActions:permissions.canAddFollowups, addedAt:new Date() } } });
    await AuditLog.create({ orgId:req.user._id, actorEmail:req.user.loginEmail, action:'ORG_ASSISTANT_MAPPING_ADDED', entityType:'AssistantMapping', summary:`Mapped ${assistantEmail} as assistant to ${principalEmail}`, metadata:{ principalEmail, assistantEmail, permissions } });
    res.redirect('/org/assistants');
  } catch(e) { next(e); }
});

router.post('/assistants/:id/remove', requireOrg, async (req, res, next) => {
  try {
    const m = await AssistantMapping.findOne({ _id:req.params.id, orgId:req.user._id }).lean();
    if (m) {
      await AssistantMapping.updateOne({ _id:req.params.id, orgId:req.user._id }, { $set:{ active:false, removedAt:new Date(), removedByEmail:req.user.loginEmail || '' } });
      const principal = await User.findOne({ org:req.user._id, email:m.principalEmail }).select({ _id:1 }).lean();
      if (principal) await User.updateOne({ _id:principal._id }, { $pull:{ collaborators:{ email:m.assistantEmail } } });
      await AuditLog.create({ orgId:req.user._id, actorEmail:req.user.loginEmail, action:'ORG_ASSISTANT_MAPPING_REMOVED', entityType:'AssistantMapping', entityId:String(req.params.id), summary:`Removed assistant ${m.assistantEmail} from ${m.principalEmail}` });
    }
    res.redirect('/org/assistants');
  } catch(e) { next(e); }
});

// GET /org/health - production trial console
router.get('/health', requireOrg, async (req, res, next) => {
  try {
    const orgId = req.user._id;
    const [users, events, transcripts, transcriptReady, summaries, threads, mappings, notes, openIssues, openErrors, syncStates, lastActivity] = await Promise.all([
      User.countDocuments({ org:orgId }),
      EventCache.countDocuments({ orgId }),
      Transcript.countDocuments({ orgId }),
      EventCache.countDocuments({ orgId, hasTranscript:true }),
      Transcript.countDocuments({ orgId, 'ai.summary': { $exists:true, $ne:'' } }),
      MeetingThread.countDocuments({ orgId, deletedAt:null }),
      AssistantMapping.countDocuments({ orgId, active:true }),
      AssistantNote.countDocuments({ orgId }),
      IssueReport.countDocuments({ orgId, status:{ $in:['open','reviewing'] } }),
      ErrorLog.countDocuments({ $and:[{ $or:[{ orgId }, { orgId:null }] }, { $or:[{ resolvedAt:null }, { resolvedAt:{ $exists:false } }] }] }),
      UserSyncState.find({ orgId }).sort({ updatedAt:-1 }).limit(12).lean(),
      PageVisitLog.findOne({ orgId }).sort({ createdAt:-1 }).lean(),
    ]);
    const checks = [
      { name:'MongoDB', status:'Connected', ok:true, detail:'Counts loaded from database' },
      { name:'Microsoft login', status: process.env.CLIENT_ID && process.env.CLIENT_SECRET ? 'Configured' : 'Check config', ok: Boolean(process.env.CLIENT_ID && process.env.CLIENT_SECRET), detail: process.env.CLIENT_ID ? 'CLIENT_ID present' : 'CLIENT_ID missing' },
      { name:'OpenAI', status: process.env.OPENAI_API_KEY ? 'Configured' : 'Missing', ok: Boolean(process.env.OPENAI_API_KEY), detail: process.env.OPENAI_MODEL || 'model not set' },
      { name:'BASE_URL', status: process.env.BASE_URL || 'Not set', ok: Boolean(process.env.BASE_URL), detail:'Used for redirects/callbacks' },
      { name:'Transcript sweep', status: String(process.env.ENABLE_TRANSCRIPT_SWEEP || 'false'), ok:true, detail:`Run on start: ${process.env.TRANSCRIPT_SWEEP_RUN_ON_START || 'false'}` },
      { name:'Environment', status: process.env.NODE_ENV || process.env.PRODUCTION || 'local', ok:true, detail:`Node ${process.version}` },
    ];
    res.render('org/health', { title:'Production health', org:req.user, checks, metrics:{ users, events, transcripts, transcriptReady, summaries, threads, mappings, notes, openIssues, openErrors }, syncStates, lastActivity });
  } catch(e) { next(e); }
});

// GET /org/settings
router.get('/settings', requireOrg, (req, res) => {
  res.render('org/settings', {
    title: 'Update details',
    org: req.user,
    saved: Boolean(req.query.saved),
  });
});

// POST /org/settings
router.post('/settings', requireOrg, async (req, res, next) => {
  try {
    const orgId = req.user._id;

    const cleanSlug = String(req.body.slug || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const domains = String(req.body.allowedDomains || '')
      .split(',')
      .map(d => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);

    const update = {
      name: String(req.body.name || '').trim(),
      slug: cleanSlug,
      allowedDomains: domains,

      o365: {
        tenantId: String(req.body.tenantId || '').trim() || null,
        enforceTenantMatch: !!req.body.enforceTenantMatch,
      },

      features: {
        checkTranscripts: !!req.body.checkTranscripts,
        debugTranscripts: !!req.body.debugTranscripts,
      },

      retention: {
        meetingDays: Number(req.body.meetingDays || 90),
        transcriptDays: Number(req.body.transcriptDays || 30),
        storeRawTranscript: !!req.body.storeRawTranscript,
      },
    };

    await Org.findByIdAndUpdate(orgId, update, { runValidators: true });
    await AuditLog.create({ orgId, actorEmail: req.user.loginEmail, action: 'ORG_SETTINGS_UPDATED', entityType: 'Org', entityId: String(orgId), summary: 'Updated org settings', metadata: update });

    // refresh req.user so page shows updated values immediately
    const fresh = await Org.findById(orgId);
    req.login(fresh, (err) => {
      if (err) return next(err);
      return res.redirect('/org/settings?saved=1');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).send('That slug is already in use.');
    }
    return next(err);
  }
});

// GET /org/activity - v28.4 page/activity logs
router.get('/activity', requireOrg, async (req, res, next) => {
  try {
    const q = {
      orgId: req.user._id,
    };
    const email = cleanEmail(req.query.email);
    const pathQuery = String(req.query.path || '').trim();
    const method = String(req.query.method || '').trim().toUpperCase();
    const actorType = String(req.query.actorType || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (email) q.actorEmail = email;
    if (pathQuery) q.path = { $regex: pathQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (['GET','POST','PUT','PATCH','DELETE'].includes(method)) q.method = method;
    if (['user','org'].includes(actorType)) q.actorType = actorType;
    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(from + 'T00:00:00');
      if (to) q.createdAt.$lte = new Date(to + 'T23:59:59');
    }
    const logs = await PageVisitLog.find(q).sort({ createdAt: -1 }).limit(500).lean();
    const topPages = await PageVisitLog.aggregate([
      { $match: { orgId: req.user._id, createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: '$path', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);
    res.render('org/activity', { title: 'Activity logs', org: req.user, logs, topPages, filters: req.query || {} });
  } catch (e) { next(e); }
});

// GET /org/diagnostics - v19 admin trust dashboard
router.get('/diagnostics', requireOrg, async (req, res, next) => {
  try {
    const orgId = req.user._id;
    const users = await User.find({ org: orgId }).select({ email:1, name:1, lastLoginAt:1, lastGraphSyncAt:1, graph:1 }).sort({ lastLoginAt:-1, updatedAt:-1 }).limit(50).lean();
    const syncStates = await UserSyncState.find({ orgId }).sort({ updatedAt:-1 }).limit(50).lean();
    const graphConfigured = Boolean(process.env.TENANT_ID || process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID) && Boolean(process.env.CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID);
    const transcriptStats = {
      totalMeetingsWithTranscript: await EventCache.countDocuments({ orgId, hasTranscript: true }),
      indexedEvents: await EventCache.countDocuments({ orgId, hasTranscript: true, aiIndexStatus: 'indexed' }),
      failedEvents: await EventCache.countDocuments({ orgId, hasTranscript: true, $or: [{ aiIndexStatus: 'failed' }, { aiIndexError: { $exists: true, $nin: ['', null] } }] }),
      totalTranscriptDocs: await Transcript.countDocuments({ orgId }),
      indexedTranscriptDocs: await Transcript.countDocuments({ orgId, aiIndexStatus: 'indexed' }),
      failedTranscriptDocs: await Transcript.countDocuments({ orgId, $or: [{ aiIndexStatus: 'failed' }, { aiIndexError: { $exists: true, $nin: ['', null] } }, { 'ai.status': 'error' }, { 'ai.detailedStatus': 'error' }] }),
    };
    const recentErrors = await ErrorLog.find({ $or: [{ orgId }, { orgId: null }] }).sort({ createdAt:-1 }).limit(15).lean();
    res.render('org/diagnostics', {
      title: 'Diagnostics', org: req.user, graphConfigured,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      sessionStore: 'MongoDB', users, syncStates, transcriptStats, recentErrors,
      healthUrl: '/health', retry: Boolean(req.query.retry)
    });
  } catch (e) { next(e); }
});

router.post('/diagnostics/retry-failed', requireOrg, async (req, res, next) => {
  try {
    const result = await resetFailedTranscriptJobs({ orgId: req.user._id, limit: 300 });
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'RETRY_FAILED_AI_JOBS', entityType: 'Diagnostics', summary: 'Admin reset failed transcript/AI jobs', metadata: result });
    res.redirect('/org/diagnostics?retry=1');
  } catch (e) { next(e); }
});

router.get('/errors', requireOrg, async (req, res, next) => {
  try {
    const logs = await ErrorLog.find({ $or: [{ orgId: req.user._id }, { orgId: null }] }).sort({ createdAt:-1 }).limit(200).lean();
    res.render('org/errors', { title: 'Error logs', org: req.user, logs });
  } catch (e) { next(e); }
});

router.post('/errors/:id/resolve', requireOrg, async (req, res, next) => {
  try {
    await ErrorLog.updateOne({ _id: req.params.id, $or: [{ orgId: req.user._id }, { orgId: null }] }, { $set: { resolvedAt: new Date() } });
    res.redirect('/org/errors');
  } catch (e) { next(e); }
});


router.get('/issues', requireOrg, async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const q = { orgId: req.user._id };
    if (['open','reviewing','resolved','dismissed'].includes(status)) q.status = status;
    const reports = await IssueReport.find(q).sort({ createdAt:-1 }).limit(300).lean();
    res.render('org/issues', { title:'Issue reports', org:req.user, reports, selectedStatus: status });
  } catch (e) { next(e); }
});

router.post('/issues/:id/status', requireOrg, async (req, res, next) => {
  try {
    const status = ['open','reviewing','resolved','dismissed'].includes(String(req.body.status || '')) ? String(req.body.status) : 'reviewing';
    const set = { status };
    if (['resolved','dismissed'].includes(status)) { set.resolvedAt = new Date(); set.resolvedByEmail = req.user.loginEmail || ''; }
    await IssueReport.updateOne({ _id:req.params.id, orgId:req.user._id }, { $set:set });
    res.redirect('/org/issues');
  } catch (e) { next(e); }
});

// GET /org/users  (list)
router.get('/users', requireOrg, async (req, res, next) => {
  try {
    const users = await User.find({ org: req.user._id, $or: [{ removedAt: null }, { removedAt: { $exists: false } }] }).sort({ createdAt: -1 });
    res.render('org/users/index', {
      title: 'Manage users',
      org: req.user,
      users,
      roleLabel,
    });
  } catch (e) {
    next(e);
  }
});

// GET /org/users/new  (form)
router.get('/users/new', requireOrg, (req, res) => {
  res.render('org/users/new', {
    title: 'Add user',
    org: req.user,
  });
});

// POST /org/users  (create one user)
router.post('/users', requireOrg, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = cleanEmail(req.body.email);
    const role = allowedRole(req.body.role);
    const permissions = { canAssignActions: !!req.body.canAssignActions, canAssignFollowups: !!req.body.canAssignFollowups, canViewAuditLog: !!req.body.canViewAuditLog };

    if (!email) return res.status(400).send('Email is required.');
    if (!checkOrgDomain(req.user, email)) return res.status(400).send('Email domain is not in this org allowed domains list.');

    await User.create({
      org: req.user._id,
      name,
      email,
      role,
      department: String(req.body.department || '').trim(),
      designation: String(req.body.designation || '').trim(),
      status: 'active',
      permissions,
    });

    res.redirect('/org/users');
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).send('User with this email already exists in this org.');
    }
    next(e);
  }
});

// GET /org/users/bulk/template.csv - downloadable CSV template
router.get('/users/bulk/template.csv', requireOrg, (req, res) => {
  const csv = orgUserTemplate(req.user);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ms-minutes-users-template.csv"');
  res.send(csv);
});

// GET /org/users/bulk - CSV upload helper
router.get('/users/bulk', requireOrg, (req, res) => {
  res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result: null, sampleCsv: orgUserTemplate(req.user) });
});

// POST /org/users/bulk - CSV textarea/file-loaded payload
router.post('/users/bulk', requireOrg, async (req, res, next) => {
  try {
    const csv = String(req.body.csv || '').trim();
    const render = result => res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result, sampleCsv: orgUserTemplate(req.user) });
    const lines = csv.split(/\r?\n/).filter(x => String(x || '').trim());
    if (lines.length < 2) return render({ error: 'Paste CSV with header and at least one user row.' });
    const headers = parseCsvLine(lines[0]).map(normalizeHeader);
    const idx = name => headers.indexOf(normalizeHeader(name));
    const required = ['name','email','role'];
    for (const h of required) if (idx(h) < 0) return render({ error: 'CSV must include name,email,role columns.' });

    let created = 0, updated = 0, skipped = 0;
    const errors = [];
    const seen = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const rowNo = i + 1;
      const email = cleanEmail(cols[idx('email')]);
      if (!email) { skipped++; errors.push('Row ' + rowNo + ': missing email'); continue; }
      if (!/^\S+@\S+\.\S+$/.test(email)) { skipped++; errors.push('Row ' + rowNo + ': invalid email ' + email); continue; }
      if (seen.has(email)) { skipped++; errors.push('Row ' + rowNo + ': duplicate email in file ' + email); continue; }
      seen.add(email);
      if (!checkOrgDomain(req.user, email)) { skipped++; errors.push('Row ' + rowNo + ': email domain is outside allowed domains — ' + email); continue; }

      const role = allowedRole(cols[idx('role')]);
      const statusRaw = String(cols[idx('status')] || 'active').toLowerCase().trim();
      const doc = {
        name: cols[idx('name')] || '',
        role,
        status: ['active','inactive'].includes(statusRaw) ? statusRaw : 'active',
        department: idx('department') >= 0 ? cols[idx('department')] || '' : '',
        designation: idx('designation') >= 0 ? cols[idx('designation')] || '' : '',
        permissions: {
          canAssignActions: idx('canassignactions') >= 0 ? truthy(cols[idx('canassignactions')]) : false,
          canAssignFollowups: idx('canassignfollowups') >= 0 ? truthy(cols[idx('canassignfollowups')]) : false,
          canViewAuditLog: idx('canviewauditlog') >= 0 ? truthy(cols[idx('canviewauditlog')]) : false,
        }
      };
      const r = await User.updateOne({ org: req.user._id, email }, { $set: doc, $setOnInsert: { org: req.user._id, email } }, { upsert: true, runValidators: true });
      if (r.upsertedCount) created++; else updated++;
    }
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'USERS_BULK_UPLOADED', entityType: 'User', summary: 'Bulk uploaded users', metadata: { created, updated, skipped, errors } });
    render({ created, updated, skipped, errors });
  } catch (e) { next(e); }
});


// POST /org/users/:id/remove - v31.2 soft-remove a user from the org admin side.
router.post('/users/:id/remove', requireOrg, async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, org: req.user._id });
    if (!user) return res.status(404).send('User not found');
    const now = new Date();
    const email = cleanEmail(user.email);
    await User.updateOne(
      { _id: user._id, org: req.user._id },
      { $set: { status: 'inactive', removedAt: now, removedByEmail: req.user.loginEmail || '', removedReason: String(req.body.reason || 'Removed by org admin').trim() || 'Removed by org admin' } }
    );
    await AssistantMapping.updateMany(
      { orgId: req.user._id, active: true, $or: [{ principalEmail: email }, { assistantEmail: email }] },
      { $set: { active: false, removedAt: now, removedByEmail: req.user.loginEmail || '' } }
    );
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'USER_REMOVED', entityType: 'User', entityId: String(user._id), summary: `Removed user ${email}`, metadata: { email, name: user.name || '' } });
    return res.redirect('/org/users');
  } catch (e) { return next(e); }
});

// GET /org/login-logs
router.get('/login-logs', requireOrg, async (req, res, next) => {
  try {
    const logs = await UserLoginLog.find({ orgId: req.user._id }).sort({ loginAt: -1 }).limit(500).lean();
    res.render('org/login_logs', { title: 'User Login Logs', org: req.user, logs });
  } catch (e) { next(e); }
});

// GET /org/users/:id/edit
router.get('/users/:id/edit', requireOrg, async (req, res, next) => {
  try {
    const editUser = await User.findOne({ _id: req.params.id, org: req.user._id });
    if (!editUser) return res.status(404).send('User not found');
    res.render('org/users/edit', { title: 'Edit user', org: req.user, editUser });
  } catch (e) { next(e); }
});

// POST /org/users/:id/edit
router.post('/users/:id/edit', requireOrg, async (req, res, next) => {
  try {
    const email = cleanEmail(req.body.email);
    if (!checkOrgDomain(req.user, email)) return res.status(400).send('Email domain is not in this org allowed domains list.');
    const update = {
      name: String(req.body.name || '').trim(),
      email,
      role: allowedRole(req.body.role),
      status: ['active','inactive'].includes(req.body.status) ? req.body.status : 'active',
      department: String(req.body.department || '').trim(),
      designation: String(req.body.designation || '').trim(),
      permissions: { canAssignActions: !!req.body.canAssignActions, canAssignFollowups: !!req.body.canAssignFollowups, canViewAuditLog: !!req.body.canViewAuditLog },
    };
    await User.updateOne({ _id: req.params.id, org: req.user._id }, { $set: update }, { runValidators: true });
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'USER_UPDATED', entityType: 'User', entityId: String(req.params.id), summary: `Updated user ${update.email}`, metadata: update });
    res.redirect('/org/users');
  } catch (e) { if (e && e.code === 11000) return res.status(409).send('User with this email already exists in this org.'); next(e); }
});

module.exports = router;
