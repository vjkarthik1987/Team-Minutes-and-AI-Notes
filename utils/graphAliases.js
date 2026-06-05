// utils/graphAliases.js
const fetch = require('node-fetch');
const { normalizeEmail, uniq } = require('./email');

async function fetchGraphEmails(accessToken) {
  const url =
    'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails,proxyAddresses';

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(json?.error?.message || `Graph /me failed ${resp.status}`);
  }

  const emails = [];

  // primary-ish
  if (json.mail) emails.push(json.mail);
  if (json.userPrincipalName) emails.push(json.userPrincipalName);

  // otherMails can include aliases
  if (Array.isArray(json.otherMails)) emails.push(...json.otherMails);

  // proxyAddresses are like "SMTP:foo@bar.com" or "smtp:alias@bar.com"
  if (Array.isArray(json.proxyAddresses)) {
    for (const p of json.proxyAddresses) {
      const s = String(p || '');
      const idx = s.indexOf(':');
      if (idx > -1) {
        const value = s.slice(idx + 1);
        if (value.includes('@')) emails.push(value);
      } else if (s.includes('@')) {
        emails.push(s);
      }
    }
  }

  return uniq(emails.map(normalizeEmail));
}

module.exports = { fetchGraphEmails };
