const express = require('express');
const passport = require('passport');
const router = express.Router();

const Org = require('../models/Org');
const User = require('../models/User');
const { syncUserPrincipals } = require('../utils/syncPrincipals');
const { saveUserGraphTokens } = require('../utils/graphTokenStore');
const UserLoginLog = require('../models/UserLoginLog');


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

// Kickoff Office 365 login. In v23.1 users no longer enter a tenant/workspace slug.
// The org is resolved after Microsoft sign-in from the user's email domain.
router.get('/office365', (req, res, next) => {

  // Avoid Passport throwing: Unknown authentication strategy "azuread"
  // when Microsoft env variables are missing or named differently.
  const strategy = passport._strategy && passport._strategy('azuread');
  if (!strategy) {
    return res.status(500).send(
      'Microsoft login is not configured on this server. Set TENANT_ID, CLIENT_ID, CLIENT_SECRET and BASE_URL=https://localhost:3000, then restart the app.'
    );
  }

  return passport.authenticate('azuread', {
    session: false,
    prompt: 'login',
  })(req, res, next);
});


// Callback (registered in Azure)
router.get(
  '/office365/callback',
  (req, res, next) => {
    const strategy = passport._strategy && passport._strategy('azuread');
    if (!strategy) return res.redirect('/user/login?login=ms-not-configured');
    return passport.authenticate('azuread', { failureRedirect: '/user/login?login=failed', session: false })(req, res, next);
  },
  async (req, res, next) => {
    try {
      const p = req.user?.profile || {};
      const email = String(p.email || '').toLowerCase().trim();
      const tid = p.tid || null;
      const oid = p.oid || null;

      if (!email) return res.redirect('/user/login?email=missing');

      // v23.1: resolve organization silently from the signed-in O365 email domain.
      // Keep joinOrgId support as a fallback for older sessions/deep links.
      const domain = email.split('@')[1] || '';
      let org = null;
      if (req.session.joinOrgId) {
        org = await Org.findById(req.session.joinOrgId);
      }
      if (!org) {
        org = await Org.findOne({ status: 'active', allowedDomains: domain });
      }
      if (!org && process.env.DEFAULT_ORG_SLUG) {
        org = await Org.findOne({ status: 'active', slug: String(process.env.DEFAULT_ORG_SLUG).toLowerCase().trim() });
      }
      if (!org && process.env.SINGLE_TENANT_ORG_SLUG) {
        org = await Org.findOne({ status: 'active', slug: String(process.env.SINGLE_TENANT_ORG_SLUG).toLowerCase().trim() });
      }
      if (!org) {
        return res.status(403).send('No active organization is configured for your email domain. Ask the admin to add your domain.');
      }

      // domain gate
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

      // bind O365 identity + login awareness for transcript onboarding
      const hadLoggedInBefore = !!dbUser.lastLoginAt || Number(dbUser.loginCount || 0) > 0;
      const nowLoginAt = new Date();
      dbUser.o365 = { oid, tid };
      if (!dbUser.firstLoginAt) dbUser.firstLoginAt = nowLoginAt;
      dbUser.lastLoginAt = nowLoginAt;
      dbUser.loginCount = Number(dbUser.loginCount || 0) + 1;
      req.session.isFirstUserLogin = !hadLoggedInBefore;
      await dbUser.save();
      try {
        await UserLoginLog.create({
          orgId: org._id, userId: dbUser._id, email: dbUser.email, name: dbUser.name, role: dbUser.role,
          loginAt: new Date(), ip: req.ip || req.headers['x-forwarded-for'] || '', userAgent: req.get('user-agent') || '', status: 'success'
        });
      } catch (e) { console.warn('[login-log] failed:', e.message || String(e)); }

      // stash tokens for Graph usage later
      const tokensToStore = req.user?.tokens || null;
      req.session.userTokens = req.user?.tokens || null;

      // v3: persist delegated Graph tokens so the 3-hour transcript sweep can run
      // without re-processing the same meeting for every attendee.
      try {
        await saveUserGraphTokens({ user: dbUser, org, tokens: tokensToStore });
      } catch (e) {
        console.warn('[graph-token] persist failed:', e.message || String(e));
      }
      // ✅ Controlled aliases: pull from Graph /me and store user.principals.emails
      try {
        const accessToken = String(tokensToStore?.access_token || '').trim();
        if (accessToken) {
          await syncUserPrincipals({ user: dbUser, org, accessToken });
        }
      } catch (e) {
        console.warn('[principals] sync failed:', e.message || String(e));
      }

      

      // clear join context
      delete req.session.joinOrgId;

      
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
