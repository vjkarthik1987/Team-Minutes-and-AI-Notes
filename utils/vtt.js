// utils/vtt.js
function vttToText(vtt = '') {
  const lines = String(vtt).split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s === 'WEBVTT') continue;
    if (/^\d+$/.test(s)) continue;       // cue number
    if (s.includes('-->')) continue;     // timestamp
    if (/^NOTE\b/i.test(s)) continue;

    // Handle <v Speaker>Text</v>
    const speakerMatch = s.match(/^<v\s+([^>]+)>(.*)$/i);

    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      const text = speakerMatch[2].replace(/<\/v>/i, '').trim();
      if (text) out.push(`${speaker}: ${text}`);
      continue;
    }

    // Fallback: strip other tags
    const cleaned = s.replace(/<[^>]+>/g, '').trim();
    if (cleaned) out.push(cleaned);
  }

  // De-duplicate consecutive identical lines
  const deduped = [];
  for (const t of out) {
    if (!deduped.length || deduped[deduped.length - 1] !== t) {
      deduped.push(t);
    }
  }

  return deduped.join('\n');
}

module.exports = { vttToText };
