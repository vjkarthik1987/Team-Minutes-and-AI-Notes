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

const authRoutes = require('./routes/auth'); // org local signup/login (you already updated this)
const orgRoutes = require('./routes/org');   // org dashboard/settings/users etc.
const userRoutes = require('./routes/user'); // user O365 login + user home
require('dotenv').config();
const isProd = process.env.NODE_ENV === 'production';


const app = express();
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));



// -------------------- DB --------------------
(async function connectDB() {
  let MONGO_URL;
  if (process.env.PRODUCTION){
    MONGO_URL = process.env.MONGO_URI;
  }
  else {
    MONGO_URL='mongodb://127.0.0.1:27017/minutes'
  }
  await mongoose.connect(MONGO_URL);
  console.log('MongoDB connected');
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
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/minutes',
      collectionName: 'sessions',
      ttl: (Number(process.env.SESSION_TTL_DAYS) || 14) * 24 * 60 * 60, // seconds
    }),
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: (Number(process.env.SESSION_TTL_DAYS) || 14) * 24 * 60 * 60 * 1000,
    },
  })
);


// -------------------- Passport init --------------------
app.use(passport.initialize());
app.use(passport.session());

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
const {
  TENANT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  BASE_URL = 'https://localhost:3000',
  OIDC_SCOPES = 'openid profile offline_access https://graph.microsoft.com/User.Read',
} = process.env;

// NOTE: This is single-tenant configuration using TENANT_ID.
// If you later go multi-tenant SaaS, we’ll adjust identityMetadata/issuer validation.
if (TENANT_ID && CLIENT_ID && CLIENT_SECRET) {
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
        allowHttpForRedirectUrl: BASE_URL.startsWith('http://'),
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
    'Azure OIDC not configured (TENANT_ID/CLIENT_ID/CLIENT_SECRET missing). User O365 login routes will not work until set.'
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

// Org local auth (signup/login)
app.use('/auth', authRoutes);

// Org area (/org)
app.use('/org', orgRoutes);

// User area (/user) - slug join + O365 login + user home
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

// -------------------- Start --------------------
const PORT = Number(process.env.PORT) || 3000;
if ((process.env.BASE_URL || '').startsWith('https://')) {
  const keyPath  = process.env.SSL_KEY_PATH  || path.join(__dirname, 'certs', 'test.key');
  const certPath = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'test.crt');

  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };

  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`HTTPS server running on https://localhost:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`HTTP server running on http://localhost:${PORT}`);
  });
}

