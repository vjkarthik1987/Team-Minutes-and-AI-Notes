const express = require('express');
const router = express.Router();

const Org = require('../models/Org');
const User = require('../models/User');

// auth guard (org must be logged in)
function requireOrg(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/auth/login');
}

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
    const role = (req.body.role === 'admin') ? 'admin' : 'user';

    if (!email) return res.status(400).send('Email is required.');

    await User.create({
      org: req.user._id,
      name,
      email,
      role,
      status: 'active',
    });

    res.redirect('/org/users');
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).send('User with this email already exists in this org.');
    }
    next(e);
  }
});



module.exports = router;
