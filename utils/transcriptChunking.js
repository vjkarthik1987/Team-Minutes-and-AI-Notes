// utils/transcriptChunking.js
function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkByChars(text, size = 3600, overlap = 500) {
  const out = [];
  const s = cleanText(text);
  if (!s) return out;
  let i = 0;
  let idx = 0;
  while (i < s.length) {
    const start = i;
    const end = Math.min(s.length, i + size);
    const piece = s.slice(start, end).trim();
    if (piece) out.push({ chunkIndex: idx++, text: piece, charStart: start, charEnd: end });
    if (end >= s.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}

module.exports = { cleanText, chunkByChars };
