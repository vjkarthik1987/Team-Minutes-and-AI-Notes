// utils/syncPrincipals.js
const { fetchGraphEmails } = require('./graphAliases');
const { uniq, filterByAllowedDomains, normalizeEmail } = require('./email');

async function syncUserPrincipals({ user, org, accessToken }) {
  const primary = normalizeEmail(user.email);
  let emails = [primary];

  try {
    const graphEmails = await fetchGraphEmails(accessToken);
    emails = emails.concat(graphEmails);
  } catch (e) {
    // Don’t fail login if alias fetch fails
    // Keep at least primary email
  }

  // Security: only keep emails within org allowedDomains if configured
  emails = filterByAllowedDomains(emails, org?.allowedDomains);

  // ensure primary always present
  if (!emails.includes(primary)) emails.unshift(primary);

  user.principals = user.principals || {};
  user.principals.emails = uniq(emails);
  user.principals.updatedAt = new Date();

  await user.save();
  return user.principals.emails;
}

module.exports = { syncUserPrincipals };
