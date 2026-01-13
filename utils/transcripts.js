// utils/transcripts.js (Node 16, CommonJS)
const fetch = require('node-fetch');

const DEBUG = (process.env.DEBUG_TRANSCRIPTS || '').toLowerCase() === 'true';
function dbg(...args) {
  if (DEBUG) console.log('[transcripts]', ...args);
}

function normHttps(url) {
  if (!url) return null;
  return String(url).trim().replace(/^http:\/\//i, 'https://');
}

function stripQuery(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return i > -1 ? s.slice(0, i) : s;
}

function escapeODataString(s) {
  return String(s || '').replace(/'/g, "''");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Simple concurrency limiter (prevents page from stalling)
async function runWithLimit(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await worker(items[cur], cur);
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, runner));
  return out;
}

async function graphJson(accessToken, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`Graph JSON ${r.status}: ${txt.slice(0, 220)}`);
  return txt ? JSON.parse(txt) : {};
}

async function graphText(accessToken, url, headers = {}) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, ...headers }
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`Graph TEXT ${r.status}: ${txt.slice(0, 220)}`);
  return txt;
}

// Extract Teams join URL from an event
function getJoinUrlFromEvent(ev) {
  const url = ev?.onlineMeeting?.joinUrl || ev?.onlineMeetingUrl || null;
  return normHttps(url);
}

/**
 * Find OnlineMeeting by join URL
 * Try:
 *  - beta/communications
 *  - beta/me
 *  - v1.0/communications
 *  - v1.0/me
 * And try eq(full), eq(base), startswith(base)
 */
async function findMeetingByJoinUrl(accessToken, joinUrl) {
  const full = normHttps(joinUrl);
  if (!full) return null;
  const base = stripQuery(full);

  const vals = [full, base];
  const filters = [];
  for (const v of vals) {
    const safe = escapeODataString(v);
    filters.push(`JoinWebUrl eq '${safe}'`);
    filters.push(`joinWebUrl eq '${safe}'`);               // some payloads use lower-case in docs/examples
    filters.push(`startswith(JoinWebUrl,'${safe}')`);
    filters.push(`startswith(joinWebUrl,'${safe}')`);
  }

  const bases = ['https://graph.microsoft.com/beta', 'https://graph.microsoft.com/v1.0'];
  const roots = ['/communications/onlineMeetings', '/me/onlineMeetings'];

  for (const b of bases) {
    for (const root of roots) {
      for (const f of filters) {
        const url = `${b}${root}?$filter=${encodeURIComponent(f)}`;
        try {
          dbg('findMeetingByJoinUrl ->', url);
          const j = await graphJson(accessToken, url);
          const arr = Array.isArray(j?.value) ? j.value : [];
          if (arr[0]?.id) return arr[0];
        } catch (e) {
          // keep trying
        }
      }
    }
  }

  return null;
}

/**
 * Fallback: find meetings by time (±90 mins)
 * Use beta/communications first. Many tenants don’t support this filter on v1.0.
 */
async function findMeetingsByTime(accessToken, event) {
  const start = new Date(event.start?.dateTime || Date.now());
  const end = new Date(event.end?.dateTime || start);

  const from = new Date(start.getTime() - 90 * 60 * 1000);
  const to = new Date(end.getTime() + 90 * 60 * 1000);

  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const candidates = [
    `https://graph.microsoft.com/beta/communications/onlineMeetings?$filter=${encodeURIComponent(
      `startDateTime ge '${fromIso}' and endDateTime le '${toIso}'`
    )}`,
    `https://graph.microsoft.com/beta/me/onlineMeetings?$filter=${encodeURIComponent(
      `startDateTime ge '${fromIso}' and endDateTime le '${toIso}'`
    )}`,
  ];

  for (const url of candidates) {
    try {
      dbg('findMeetingsByTime ->', url);
      const j = await graphJson(accessToken, url);
      const arr = Array.isArray(j?.value) ? j.value : [];
      if (arr.length) return arr;
    } catch (e) {
      dbg('findMeetingsByTime failed:', e.message);
    }
  }

  return [];
}



/**
 * List transcripts for a meetingId
 * beta/communications is typically the most reliable.
 */
async function listTranscripts(accessToken, meetingId) {
  const urls = [
    `https://graph.microsoft.com/beta/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
    `https://graph.microsoft.com/beta/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
    // fallback (some tenants)
    `https://graph.microsoft.com/v1.0/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
  ];

  for (const url of urls) {
    try {
      dbg('listTranscripts ->', url);
      const j = await graphJson(accessToken, url);
      const items = Array.isArray(j?.value) ? j.value : [];
      return { items, status: 200, used: url };
    } catch (e) {
      dbg('listTranscripts failed:', e.message);
    }
  }

  return { items: [], status: 0, used: null };
}

/**
 * Download transcript content using Accept header (avoid $format issues)
 */
async function getTranscript(accessToken, meetingId, transcriptId, accept = 'text/vtt') {
  const urls = [
    `https://graph.microsoft.com/beta/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
    `https://graph.microsoft.com/beta/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
    `https://graph.microsoft.com/v1.0/communications/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
    `https://graph.microsoft.com/v1.0/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`,
  ];

  for (const url of urls) {
    try {
      dbg('getTranscript ->', url, 'accept=', accept);
      return await graphText(accessToken, url, { Accept: accept });
    } catch (e) {
      dbg('getTranscript failed:', e.message);
    }
  }

  throw new Error('Transcript content not available.');
}

/**
 * Annotate events with transcript availability
 * - respects CHECK_TRANSCRIPTS
 * - only checks events that have a joinUrl
 * - DOES NOT depend on “Graph connected” org flag
 *
 * Note: Not “about limiting events”: this is about correct endpoints + matching.
 */
async function annotateEventsWithTranscripts(accessToken, events, opts = {}) {
  const enabled = (process.env.CHECK_TRANSCRIPTS || '').toLowerCase() === 'true';
  if (!enabled) return events;

  if (!accessToken || !accessToken.trim()) {
    dbg('skipped: empty access token');
    return events.map(ev => ({ ...ev, _hasTranscript: false, _tReason: 'no-token' }));
  }

  const maxChecks = Number(opts.maxChecks ?? 30);
  const concurrency = Number(opts.concurrency ?? 4); // keeps page responsive

  // IMPORTANT: keep original array but annotate in place
  const working = events.map(ev => ({ ...ev }));

  // Candidates: must have join URL
  const candidates = working.filter(ev => getJoinUrlFromEvent(ev)).slice(0, maxChecks);

  await runWithLimit(candidates, concurrency, async (ev) => {
    try {
      const joinUrl = getJoinUrlFromEvent(ev);
      let mtg = null;

      // 1) Direct joinUrl
      mtg = await findMeetingByJoinUrl(accessToken, joinUrl);

      // 2) Fallback time window
      if (!mtg) {
        const nearby = await findMeetingsByTime(accessToken, ev);
        if (nearby.length) {
          const base = stripQuery(joinUrl);
          mtg =
            nearby.find(m => stripQuery(normHttps(m.joinWebUrl || m.JoinWebUrl || '')) === base) ||
            nearby[0];
        }
      }

      if (!mtg?.id) {
        ev._hasTranscript = false;
        ev._tReason = 'no-meeting-match';
        return;
      }

      const { items, used } = await listTranscripts(accessToken, mtg.id);

      if (!items.length) {
        ev._hasTranscript = false;
        ev._tReason = `no-transcripts (endpoint=${used || 'none'})`;
        return;
      }

      ev._hasTranscript = true;
      ev._transcripts = items.map(t => ({
        id: t.id,
        createdDateTime: t.createdDateTime || null,
        meetingId: mtg.id,
      }));

      ev._tReason = `found(${items.length})`;
      dbg('joinUrl=', joinUrl);
      dbg('meeting from joinUrl?', !!mtg);

      if (!mtg) dbg('joinUrl match failed; trying time window...');

    } catch (e) {
      ev._hasTranscript = false;
      ev._tReason = `error:${e.message}`;
    }
  });

  // If not annotated, mark as false
  for (const ev of working) {
    if (typeof ev._hasTranscript === 'undefined') {
      ev._hasTranscript = false;
      if (DEBUG) ev._tReason = 'not-checked';
    }
  }

  return working;
}

module.exports = { annotateEventsWithTranscripts, getTranscript };
