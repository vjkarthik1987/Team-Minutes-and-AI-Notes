// utils/acl.js
function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function getUserPrincipals(user) {
  const primary = normalizeEmail(user?.email);
  const list = Array.isArray(user?.principals?.emails) ? user.principals.emails : [];
  const all = [primary, ...list].map(normalizeEmail).filter(Boolean);
  return [...new Set(all)];
}

function canUserAccessTranscriptByEmails(userEmails, transcript) {
  const allowed = Array.isArray(transcript?.acl?.allowedEmails) ? transcript.acl.allowedEmails : [];
  if (!allowed.length) return false;

  const userSet = new Set((userEmails || []).map(normalizeEmail));
  return allowed.some(e => userSet.has(normalizeEmail(e)));
}

module.exports = { getUserPrincipals, canUserAccessTranscriptByEmails };
