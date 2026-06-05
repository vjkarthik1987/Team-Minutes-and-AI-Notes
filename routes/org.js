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
const { resetFailedTranscriptJobs } = require('../utils/jobRetry');

// auth guard (org must be logged in)
function requireOrg(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/auth/login');
}


// Backward-compatible redirect. Org/Admin login lives under /auth/login.
router.get('/login', (req, res) => res.redirect('/auth/login'));

// GET /org
router.get('/', requireOrg, (req, res) => {
  res.render('org/index', {
    title: 'Org Dashboard',
    org: req.user, // req.user IS the Org
  });
});

// GET /org/usage
router.get('/usage', requireOrg, (req, res) => {
  res.send('Usage – coming soon');
});

// GET /org/settings
router.get('/settings', requireOrg, (req, res) => {
  res.render('org/settings', {
    title: 'Update details',
    org: req.user,
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

    // refresh req.user so page shows updated values immediately
    const fresh = await Org.findById(orgId);
    req.login(fresh, (err) => {
      if (err) return next(err);
      return res.redirect('/org/settings');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).send('That slug is already in use.');
    }
    return next(err);
  }
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

// GET /org/users  (list)
router.get('/users', requireOrg, async (req, res, next) => {
  try {
    const users = await User.find({ org: req.user._id }).sort({ createdAt: -1 });
    res.render('org/users/index', {
      title: 'Manage users',
      org: req.user,
      users,
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
    const email = String(req.body.email || '').toLowerCase().trim();
    const allowedRoles = ['ceo', 'general_user', 'super_admin', 'admin', 'org_admin', 'superadmin', 'user', 'member'];
    const role = allowedRoles.includes(req.body.role) ? User.normalizeRole(req.body.role) : 'general_user';
    const permissions = { canAssignActions: !!req.body.canAssignActions, canAssignFollowups: !!req.body.canAssignFollowups, canViewAuditLog: !!req.body.canViewAuditLog };

    if (!email) return res.status(400).send('Email is required.');

    await User.create({
      org: req.user._id,
      name,
      email,
      role,
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



// GET /org/users/bulk - CSV upload helper
router.get('/users/bulk', requireOrg, (req, res) => {
  res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result: null });
});

// POST /org/users/bulk - CSV textarea/file-loaded payload
router.post('/users/bulk', requireOrg, async (req, res, next) => {
  try {
    const csv = String(req.body.csv || '').trim();
    const lines = csv.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines.length < 2) return res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result: { error: 'Paste CSV with header and at least one row.' } });
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idx = name => headers.indexOf(name);
    const required = ['name','email','role'];
    for (const h of required) if (idx(h) < 0) return res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result: { error: 'CSV must include name,email,role columns.' } });
    let created = 0, updated = 0, skipped = 0; const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const email = String(cols[idx('email')] || '').toLowerCase().trim();
      if (!email) { skipped++; errors.push('Row '+(i+1)+': missing email'); continue; }
      const doc = {
        name: cols[idx('name')] || '',
        role: User.normalizeRole(cols[idx('role')] || 'general_user'),
        status: ['active','inactive'].includes(cols[idx('status')]) ? cols[idx('status')] : 'active',
        permissions: {
          canAssignActions: ['true','yes','1'].includes(String(cols[idx('canassignactions')] || '').toLowerCase()),
          canAssignFollowups: ['true','yes','1'].includes(String(cols[idx('canassignfollowups')] || '').toLowerCase()),
          canViewAuditLog: ['true','yes','1'].includes(String(cols[idx('canviewauditlog')] || '').toLowerCase()),
        }
      };
      const r = await User.updateOne({ org: req.user._id, email }, { $set: doc, $setOnInsert: { org: req.user._id, email } }, { upsert: true, runValidators: true });
      if (r.upsertedCount) created++; else updated++;
    }
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'USERS_BULK_UPLOADED', entityType: 'User', summary: 'Bulk uploaded users', metadata: { created, updated, skipped, errors } });
    res.render('org/users/bulk', { title: 'Bulk upload users', org: req.user, result: { created, updated, skipped, errors } });
  } catch (e) { next(e); }
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
    const allowedRoles = ['ceo', 'general_user', 'super_admin', 'admin', 'org_admin', 'superadmin', 'user', 'member'];
    const update = {
      name: String(req.body.name || '').trim(),
      email: String(req.body.email || '').toLowerCase().trim(),
      role: allowedRoles.includes(req.body.role) ? User.normalizeRole(req.body.role) : 'general_user',
      status: ['active','inactive'].includes(req.body.status) ? req.body.status : 'active',
      permissions: { canAssignActions: !!req.body.canAssignActions, canAssignFollowups: !!req.body.canAssignFollowups, canViewAuditLog: !!req.body.canViewAuditLog },
    };
    await User.updateOne({ _id: req.params.id, org: req.user._id }, { $set: update }, { runValidators: true });
    await AuditLog.create({ orgId: req.user._id, actorEmail: req.user.loginEmail, action: 'USER_UPDATED', entityType: 'User', entityId: String(req.params.id), summary: `Updated user ${update.email}`, metadata: update });
    res.redirect('/org/users');
  } catch (e) { if (e && e.code === 11000) return res.status(409).send('User with this email already exists in this org.'); next(e); }
});


module.exports = router;
