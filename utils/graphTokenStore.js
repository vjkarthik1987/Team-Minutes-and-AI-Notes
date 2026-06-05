// utils/graphTokenStore.js
const fetch = require('node-fetch');
const UserGraphToken = require('../models/UserGraphToken');

function tokenExpiryDate(tokens) {
  const expiresAt = tokens?.expires_at ? new Date(Number(tokens.expires_at)) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime())) return expiresAt;
  return new Date(Date.now() + 50 * 60 * 1000);
}

async function saveUserGraphTokens({ user, org, tokens }) {
  if (!user || !org || !tokens) return null;
  const accessToken = String(tokens.access_token || '').trim();
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!accessToken && !refreshToken) return null;

  return UserGraphToken.findOneAndUpdate(
    { user: user._id },
    {
      $set: {
        org: org._id || org,
        user: user._id,
        email: String(user.email || '').toLowerCase().trim(),
        tid: String(user.o365?.tid || ''),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        scope: String(tokens.scope || ''),
        expiresAt: tokenExpiryDate(tokens),
        lastError: '',
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
}

async function refreshGraphToken(tokenDoc) {
  if (!tokenDoc?.refreshToken) throw new Error('No refresh token available. User must sign in again.');

  const TENANT_ID = process.env.TENANT_ID || process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID || tokenDoc.tid || 'common';
  const CLIENT_ID = process.env.CLIENT_ID || process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
  const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
  const scope = process.env.OIDC_SCOPES || tokenDoc.scope || 'openid profile offline_access https://graph.microsoft.com/User.Read Calendars.Read OnlineMeetings.Read.All OnlineMeetingTranscript.Read.All';

  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing CLIENT_ID/CLIENT_SECRET for token refresh.');

  const body = new URLSearchParams();
  body.set('client_id', CLIENT_ID);
  body.set('client_secret', CLIENT_SECRET);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', tokenDoc.refreshToken);
  body.set('scope', scope);

  const resp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.error_description || json?.error || `token refresh failed ${resp.status}`;
    await UserGraphToken.updateOne({ _id: tokenDoc._id }, { $set: { lastError: msg } });
    throw new Error(msg);
  }

  tokenDoc.accessToken = json.access_token || tokenDoc.accessToken;
  if (json.refresh_token) tokenDoc.refreshToken = json.refresh_token;
  tokenDoc.scope = json.scope || tokenDoc.scope;
  tokenDoc.expiresAt = new Date(Date.now() + (Number(json.expires_in || 3600) - 90) * 1000);
  tokenDoc.lastRefreshedAt = new Date();
  tokenDoc.lastError = '';
  await tokenDoc.save();
  return tokenDoc.accessToken;
}

async function getFreshAccessTokenForUser(userId) {
  const tokenDoc = await UserGraphToken.findOne({ user: userId });
  if (!tokenDoc) throw new Error('No stored Graph token for user. User must sign in once.');

  const expiresAt = tokenDoc.expiresAt ? new Date(tokenDoc.expiresAt).getTime() : 0;
  const hasFreshAccessToken = tokenDoc.accessToken && expiresAt > Date.now() + 5 * 60 * 1000;
  if (hasFreshAccessToken) return tokenDoc.accessToken;
  return refreshGraphToken(tokenDoc);
}

module.exports = { saveUserGraphTokens, getFreshAccessTokenForUser, refreshGraphToken };
