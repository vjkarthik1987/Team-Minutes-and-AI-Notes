// middleware/ensureUserFreshToken.js
module.exports = async function ensureUserFreshToken(req, res, next) {
  try {
    const tokens = req.session?.userTokens || null;

    if (!tokens || !tokens.access_token) {
      res.locals.userTokens = null;
      return next();
    }

    // For now, assume token is valid
    res.locals.userTokens = tokens;
    return next();
  } catch (e) {
    console.error('[ensureUserFreshToken] error:', e.message);
    res.locals.userTokens = null;
    return next();
  }
};