// server.js
const path = require('path');
const express = require('express');
const engine = require('ejs-mate');
const https = require('https');
const fs = require('fs');
const MongoStorePkg = require('connect-mongo');
const MongoStore = MongoStorePkg.default || MongoStorePkg;



const mongoose = require('mongoose');
const session = require('express-session');

const passport = require('passport');
const LocalStrategy = require('passport-local');
const { OIDCStrategy } = require('passport-azure-ad');

const Org = require('./models/Org');
const User = require('./models/User');
const ErrorLog = require('./models/ErrorLog');
const PageVisitLog = require('./models/PageVisitLog');

const authRoutes = require('./routes/auth'); // org local signup/login (you already updated this)
const orgRoutes = require('./routes/org');   // org dashboard/settings/users etc.
const userRoutes = require('./routes/user');
const { startThreadDigestScheduler } = require('./workers/threadDigest.worker'); // user O365 login + user home
const { startTranscriptSweepScheduler } = require('./workers/transcriptSweep.worker');
const { startSummaryDigestScheduler } = require('./workers/summaryDigest.worker');
const { startDailyExecutiveBriefScheduler } = require('./jobs/dailyExecutiveBrief.job');
const { startDailyCalendarRefreshScheduler } = require('./jobs/dailyCalendarRefresh.job');
require('dotenv').config();
const isProd = ['true', '1', 'yes'].includes(String(process.env.PRODUCTION || process.env.NODE_ENV === 'production' ? process.env.PRODUCTION || 'true' : '').toLowerCase());
const rawBaseUrl = (process.env.BASE_URL || 'https://localhost:3000').trim().replace(/\/$/, '');
const baseUrlIsHttps = rawBaseUrl.toLowerCase().startsWith('https://');
const allowHttpRedirectForDev = String(process.env.ALLOW_HTTP_REDIRECT_FOR_MS || '').toLowerCase() === 'true';

// Microsoft Entra ID / Graph auth should use HTTPS redirect URLs.
// Local development runs an HTTPS server by default; production usually gets HTTPS from Railway/Nginx/Load Balancer.
const wantsHttpsLocal = !isProd && String(process.env.LOCAL_HTTPS || 'true').toLowerCase() !== 'false';

if ((process.env.TENANT_ID && process.env.CLIENT_ID && process.env.CLIENT_SECRET) && !baseUrlIsHttps && !allowHttpRedirectForDev) {
  throw new Error(
    `BASE_URL must be HTTPS for Microsoft authentication. Current BASE_URL=${rawBaseUrl}. ` +
    'Use https://localhost:3000 locally, or set ALLOW_HTTP_REDIRECT_FOR_MS=true only for throwaway local testing.'
  );
}


const app = express();
app.set('trust proxy', 1);

// In production, HTTPS is usually terminated before Node. This ensures users and Microsoft redirects stay on HTTPS.
app.use((req, res, next) => {
  const forwardedProto = req.get('x-forwarded-proto');
  if (isProd && forwardedProto && forwardedProto !== 'https') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  return next();
});

app.use(express.static(path.join(__dirname, 'public')));
// v24.9: explicit upload route improves local HTTPS preview reliability for files/images attached to thread diary entries.
app.get('/uploads/meeting-files/:filename', (req, res) => {
  const safeName = path.basename(String(req.params.filename || ''));
  const filePath = path.join(__dirname, 'uploads', 'meeting-files', safeName);
  return res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).send('Uploaded file not found');
  });
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads/meeting-files', express.static(path.join(__dirname, 'uploads', 'meeting-files')));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));



// -------------------- DB --------------------
(async function connectDB() {
  let MONGO_URL;
  if (isProd) {
    MONGO_URL = process.env.MONGO_URI;
  } else {
    MONGO_URL = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/minutes';
  }
  await mongoose.connect(MONGO_URL);
  console.log('MongoDB connected');
  startTranscriptSweepScheduler();
  startSummaryDigestScheduler();
  startDailyExecutiveBriefScheduler();
  startDailyCalendarRefreshScheduler();
})().catch((err) => {
  console.error('Mongo connection error:', err);
  process.exit(1);
});

// -------------------- Views --------------------
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------------------- Body parsing --------------------
app.use(express.urlencoded({ extended: true }));

// -------------------- Session --------------------
app.use(
  session({
    name: process.env.SESSION_COOKIE_NAME || 'minutes.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      mongoUrl: isProd
        ? process.env.MONGO_URI
        : (process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/minutes'),
      ttl: (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60,
      touchAfter: 24 * 60 * 60,
    }),
    cookie: {
      httpOnly: true,
      secure: isProd || wantsHttpsLocal,
      sameSite: 'lax',
      maxAge: (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000,
    },
  })
);


// -------------------- Passport init --------------------
app.use(passport.initialize());
app.use(passport.session());

// v28.4: lightweight page/activity logging for launch visibility.
// Logs authenticated /user and /org page visits/actions, but skips background polling/chat/static-style calls.
function shouldLogActivity(req) {
  const path = String(req.path || req.originalUrl || '');
  if (!req.user) return false;
  if (!(path.startsWith('/user') || path.startsWith('/org'))) return false;
  const excluded = [
    /^\/user\/shell\/status$/,
    /^\/user\/chat\//,
    /^\/user\/people\/search$/,
    /^\/user\/notifications/,
    /^\/uploads\//,
    /^\/org\/users\/bulk\/template\.csv$/,
  ];
  if (excluded.some(rx => rx.test(path))) return false;
  if (req.method === 'GET') {
    const accept = String(req.get('accept') || '');
    return accept.includes('text/html') || accept === '*/*' || !accept;
  }
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
}

app.use((req, res, next) => {
  if (!shouldLogActivity(req)) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    try {
      const isUser = Boolean(req.user?.org);
      const orgId = isUser ? req.user.org?._id : req.user?._id;
      if (!orgId) return;
      const queryKeys = Object.keys(req.query || {});
      PageVisitLog.create({
        orgId,
        actorType: isUser ? 'user' : 'org',
        userId: isUser ? req.user._id : null,
        actorEmail: String(isUser ? req.user.email : req.user.loginEmail || '').toLowerCase(),
        actorName: String(isUser ? (req.user.name || '') : (req.user.name || 'Org admin')),
        actorRole: String(isUser ? (req.user.role || '') : 'org_admin'),
        method: req.method,
        route: req.originalUrl || req.url || '',
        path: req.path || '',
        statusCode: res.statusCode || 0,
        ip: req.ip || req.connection?.remoteAddress || '',
        userAgent: String(req.get('user-agent') || '').slice(0, 600),
        referrer: String(req.get('referer') || '').slice(0, 600),
        isMutation: req.method !== 'GET',
        durationMs: Date.now() - startedAt,
        metadata: { queryKeys, bodyKeys: req.method === 'GET' ? [] : Object.keys(req.body || {}) },
      }).catch(e => console.warn('[activity-log failed]', e.message || e));
    } catch (e) {
      console.warn('[activity-log failed]', e.message || e);
    }
  });
  return next();
});

// -------------------- Strategy 1: Org local login --------------------
passport.use(
  'org-local',
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const org = await Org.findOne({
        loginEmail: String(email).toLowerCase().trim(),
      });

      if (!org) return done(null, false);
      if (org.status !== 'active') return done(null, false);

      const ok = await org.validatePassword(password);
      if (!ok) return done(null, false);

      return done(null, org);
    } catch (e) {
      return done(e);
    }
  })
);

// -------------------- Strategy 2: Office 365 (OIDC) for Users --------------------
const TENANT_ID = process.env.TENANT_ID || process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
const OIDC_SCOPES = process.env.OIDC_SCOPES || 'openid profile offline_access https://graph.microsoft.com/User.Read';
const BASE_URL = rawBaseUrl;
const azureConfigured = Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
app.locals.azureConfigured = azureConfigured;
app.locals.sessionStore = 'MongoDB';
app.locals.appVersion = '28.4.0';

// NOTE: This is single-tenant configuration using TENANT_ID.
// If you later go multi-tenant SaaS, we’ll adjust identityMetadata/issuer validation.
if (azureConfigured) {
  passport.use(
    'azuread',
    new OIDCStrategy(
      {
        identityMetadata: `https://login.microsoftonline.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`,
        clientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        responseType: 'code',
        responseMode: 'query',
        redirectUrl: `${BASE_URL}/auth/office365/callback`,
        allowHttpForRedirectUrl: allowHttpRedirectForDev,
        scope: OIDC_SCOPES.split(/\s+/),
        validateIssuer: true,
        loggingLevel: 'warn',
      },
      (iss, sub, profile, accessToken, refreshToken, params, done) => {
        try {
          const email =
            (profile?._json?.preferred_username ||
              profile?.upn ||
              profile?._json?.email ||
              '')
              .toLowerCase()
              .trim();

          const oid = profile?.oid || profile?.sub || null;
          const tid = profile?._json?.tid || null;

          // We return a temporary object; the user router will map this to a DB User + req.login(dbUser)
          return done(null, {
            profile: {
              email,
              displayName: profile?.displayName || profile?.name || '',
              oid,
              tid,
            },
            tokens: {
              access_token: accessToken || '',
              refresh_token: refreshToken || '',
              scope: params?.scope || '',
              expires_at: params?.expires_in
                ? Date.now() + (Number(params.expires_in) - 60) * 1000
                : 0,
            },
          });
        } catch (e) {
          return done(e);
        }
      }
    )
  );
} else {
  console.warn(
    'Azure OIDC not configured. Set TENANT_ID/CLIENT_ID/CLIENT_SECRET (or AZURE_/MS_ aliases). User O365 login routes are disabled until configured.'
  );
}

// -------------------- Session principal: Org OR User --------------------
passport.serializeUser((entity, done) => {
  // Org has slug + loginEmail in your schema
  if (entity && entity.slug && entity.loginEmail) {
    return done(null, { kind: 'org', id: entity.id });
  }
  // DB User has org field + email
  return done(null, { kind: 'user', id: entity.id });
});

passport.deserializeUser(async (key, done) => {
  try {
    if (!key || !key.kind) return done(null, false);

    if (key.kind === 'org') {
      const org = await Org.findById(key.id);
      return done(null, org || false);
    }

    if (key.kind === 'user') {
      const user = await User.findById(key.id).populate('org');
      return done(null, user || false);
    }

    return done(null, false);
  } catch (e) {
    return done(e);
  }
});

// -------------------- Routes --------------------
app.get('/', (req, res) => {
  res.render('index', { title: 'Home' });
});

app.get('/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbLabels = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const checks = {
    app: 'ok',
    version: app.locals.appVersion,
    uptimeSeconds: Math.round(process.uptime()),
    db: dbLabels[dbState] || String(dbState),
    sessionStore: 'MongoDB',
    graphConfigured: azureConfigured,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    environment: process.env.NODE_ENV || (isProd ? 'production' : 'development'),
    timestamp: new Date().toISOString(),
  };
  const ok = dbState === 1;
  res.status(ok ? 200 : 503).json({ ok, checks });
});

app.get('/healthz', async (req, res) => res.redirect('/health'));


// Org local auth (signup/login)
app.use('/auth', authRoutes);

// Org area (/org)
app.use('/org', orgRoutes);

// User area (/user) - direct O365 login + user home
app.use('/user', userRoutes);

// Org logout (POST)
app.post('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/'));
  });
});

// User logout (POST) – same endpoint is fine too; keeping separate is clearer
app.post('/user/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/user/login'));
  });
});


// -------------------- Error logging --------------------
app.use(async (err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  try {
    await ErrorLog.create({
      orgId: req.user?.org?._id || (req.user?.slug ? req.user?._id : null),
      userId: req.user?.org ? req.user?._id : null,
      actorEmail: req.user?.email || req.user?.loginEmail || '',
      level: status >= 500 ? 'error' : 'warn',
      source: 'express',
      message: err.message || String(err),
      stack: process.env.NODE_ENV === 'production' ? '' : (err.stack || ''),
      route: req.originalUrl || req.url || '',
      method: req.method || '',
      statusCode: status,
      metadata: { query: req.query || {}, bodyKeys: Object.keys(req.body || {}) },
    });
  } catch (logErr) {
    console.error('[error-log failed]', logErr);
  }
  console.error(err);
  if (res.headersSent) return next(err);
  return res.status(status).send(status >= 500 ? 'Something broke. The error has been logged.' : (err.message || 'Request failed'));
});

// -------------------- Start --------------------
const PORT = Number(process.env.PORT) || 3000;

// Your variable: PRODUCTION=TRUE in Railway, FALSE locally

// Local: if BASE_URL starts with https OR you explicitly set LOCAL_HTTPS=true


if (wantsHttpsLocal) {
  const keyPath  = process.env.SSL_KEY_PATH  || path.join(__dirname, 'certs', 'test.key');
  const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'test.crt');

  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };

  https.createServer(httpsOptions, app).listen(PORT, () => {
    startThreadDigestScheduler();
    console.log(`HTTPS (local) server running on https://localhost:${PORT}`);
  });
} else {
  // Production: Railway/Nginx terminates HTTPS and forwards to this HTTP port.
  // Local: set LOCAL_HTTPS=false only when not testing Microsoft auth/Graph.
  app.listen(PORT, () => {
    startThreadDigestScheduler();
    console.log(`HTTP server running on port ${PORT}`);
    if (azureConfigured) {
      console.warn('Microsoft auth is configured. Use HTTPS BASE_URL for login/callbacks.');
    }
  });
}



