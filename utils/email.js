// utils/email.js
function normalizeEmail(e) {
    return String(e || '').trim().toLowerCase();
  }
  
  function uniq(arr) {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
      const x = String(v || '').trim();
      if (!x) continue;
      const k = x.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }
  
  function intersect(a, b) {
    const A = new Set((a || []).map(normalizeEmail));
    for (const x of (b || []).map(normalizeEmail)) {
      if (A.has(x)) return true;
    }
    return false;
  }
  
  function filterByAllowedDomains(emails, allowedDomains) {
    const domains = (allowedDomains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);
    if (!domains.length) return uniq(emails);
  
    return uniq(emails).filter(e => {
      const parts = e.split('@');
      if (parts.length !== 2) return false;
      return domains.includes(parts[1]);
    });
  }
  
  module.exports = { normalizeEmail, uniq, intersect, filterByAllowedDomains };
  