// utils/vtt.js
function vttToText(vtt = '') {
  const lines = String(vtt).split(/\r?\n/);

  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s === 'WEBVTT') continue;
    if (/^\d+$/.test(s)) continue; // cue number
    if (s.includes('-->')) continue; // timestamp line
    if (/^NOTE\b/i.test(s)) continue;

    // remove tags like <v Speaker>
    const cleaned = s.replace(/<[^>]+>/g, '').trim();
    if (cleaned) out.push(cleaned);
  }

  // de-duplicate repeated consecutive lines
  const deduped = [];
  for (const t of out) {
    if (!deduped.length || deduped[deduped.length - 1] !== t) deduped.push(t);
  }

  return deduped.join('\n');
}

module.exports = { vttToText };
