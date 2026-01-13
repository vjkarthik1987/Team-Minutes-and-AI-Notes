const express = require('express');
const passport = require('passport');
const router = express.Router();

const Org = require('../models/Org');
const User = require('../models/User');

// GET /auth/signup
router.get('/signup', (req, res) => {
  res.render('auth/signup', { title: 'Org signup' });
});

// POST /auth/signup (create Org + auto-login)
router.post('/signup', async (req, res, next) => {
  try {
    const { name, slug, allowedDomains, loginEmail, password } = req.body;

    const cleanSlug = String(slug || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const domains = String(allowedDomains || '')
      .split(',')
      .map(d => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);

    if (!name || !cleanSlug || domains.length === 0) {
      return res.status(400).send('Missing org fields.');
    }
    if (!loginEmail || !password || String(password).length < 8) {
      return res.status(400).send('Invalid org login credentials (min 8 chars).');
    }

    const passwordHash = await Org.hashPassword(String(password));

    const org = await Org.create({
      name: String(name).trim(),
      slug: cleanSlug,
      allowedDomains: domains,
      loginEmail: String(loginEmail).toLowerCase().trim(),
      passwordHash,
      // optional: features/retention defaults are in schema
    });

    // Auto-login after signup
    req.login(org, (err) => {
      if (err) return next(err);
      return res.redirect('/org');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).send('Org slug or org login email already exists.');
    }
    return next(err);
  }
});

// GET /auth/login
router.get('/login', (req, res) => {
  res.render('auth/login', { title: 'Org login' });
});

// POST /auth/login (Org local login)
router.post(
  '/login',
  passport.authenticate('org-local', {
    failureRedirect: '/auth/login',
  }),
  (req, res) => res.redirect('/org')
);

// Kickoff Office 365 login (slug must already be stored in session)
router.get(
  '/office365',
  passport.authenticate('azuread', {
    session: false,
    prompt: 'login', // always ask username/password
    // OR: prompt: 'select_account'  // user picks account each time
  })
);


// Callback (registered in Azure)
router.get(
  '/office365/callback',
  passport.authenticate('azuread', { failureRedirect: '/user/login?login=failed', session: false }),
  async (req, res, next) => {
    try {
      const joinOrgId = req.session.joinOrgId;
      if (!joinOrgId) return res.redirect('/user/login?org=missing');
      console.log('joinOrgId in callback:', req.session.joinOrgId);

      const org = await Org.findById(joinOrgId);
      if (!org) return res.redirect('/user/login?org=missing');

      const p = req.user?.profile || {};
      const email = String(p.email || '').toLowerCase().trim();
      const tid = p.tid || null;
      const oid = p.oid || null;

      if (!email) return res.redirect('/user/login?email=missing');

      // domain gate
      const domain = email.split('@')[1] || '';
      if (!org.allowedDomains?.includes(domain)) {
        return res.status(403).send('Your email domain is not allowed for this org.');
      }

      // tenant gate (optional but recommended)
      if (org.o365?.enforceTenantMatch && org.o365?.tenantId) {
        if (!tid || String(tid).toLowerCase() !== String(org.o365.tenantId).toLowerCase()) {
          return res.status(403).send('Tenant mismatch for this org.');
        }
      }

      // must exist in org user list
      const dbUser = await User.findOne({ org: org._id, email, status: 'active' });
      if (!dbUser) {
        return res.status(403).send('User not found in org. Ask org admin to add you.');
      }

      // bind O365 identity
      dbUser.o365 = { oid, tid };
      dbUser.lastLoginAt = new Date();
      await dbUser.save();

      // stash tokens for Graph usage later
      req.session.userTokens = req.user?.tokens || null;
      

      // clear join context
      delete req.session.joinOrgId;

      const tokensToStore = req.user?.tokens || null;
      req.login(dbUser, (err) => {
        if (err) return next(err);
      
        // store tokens in session for later Graph calls
        req.session.userTokens = tokensToStore;
      
        // optional: clear join context
        delete req.session.joinOrgId;
      
        // ensure it's saved before redirect
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          return res.redirect('/user/home');
        });
      });      
    } catch (e) {
      next(e);
    }
  }
);

module.exports = router;
