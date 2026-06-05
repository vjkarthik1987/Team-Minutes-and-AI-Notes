// middleware/ensureUserFreshToken.js
const { syncUserPrincipals } = require('../utils/syncPrincipals');

const PRINCIPAL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

module.exports = async function ensureUserFreshToken(req, res, next) {
  try {
    const tokens = req.session?.userTokens || null;

    if (!tokens || !tokens.access_token) {
      res.locals.userTokens = null;
      return next();
    }

    // Expose token to downstream routes
    res.locals.userTokens = tokens;

    // ---- Controlled alias sync (non-blocking) ----
    try {
      const user = req.user;
      const org = req.user?.org;

      if (user && org) {
        const lastSync = user.principals?.updatedAt
          ? new Date(user.principals.updatedAt).getTime()
          : 0;

        const now = Date.now();
        const isStale = now - lastSync > PRINCIPAL_SYNC_INTERVAL_MS;

        // Sync only if missing or stale
        if (!Array.isArray(user.principals?.emails) || isStale) {
          await syncUserPrincipals({
            user,
            org,
            accessToken: tokens.access_token,
          });
        }
      }
    } catch (e) {
      // Never block user requests for alias issues
      console.warn('[principals] sync skipped:', e.message || String(e));
    }

    return next();
  } catch (e) {
    console.error('[ensureUserFreshToken] error:', e.message);
    res.locals.userTokens = null;
    return next();
  }
};
