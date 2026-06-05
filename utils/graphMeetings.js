// utils/graphMeetings.js
const fetch = require('node-fetch');

async function graphGET(accessToken, url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="Asia/Kolkata"',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function graphGETText(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET text failed (${res.status}): ${text}`);
  }
  return res.text();
}

// Fetch event (for joinUrl / onlineMeetingUrl)
async function getEvent(accessToken, eventId) {
  const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=id,subject,start,end,onlineMeeting,onlineMeetingUrl,isOnlineMeeting`;
  return graphGET(accessToken, url);
}

// Try to resolve OnlineMeeting by join URL (delegated)
// Note: This often works, but Graph can be picky about filtering.
// We try /me/onlineMeetings first, then /communications/onlineMeetings.
async function findOnlineMeetingByJoinUrl(accessToken, joinUrl) {
  const safeJoin = String(joinUrl || '').replace(/'/g, "''"); // escape single quotes
  const filter = encodeURIComponent(`JoinWebUrl eq '${safeJoin}'`);

  const urlsToTry = [
    `https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=${filter}&$top=1`,
    `https://graph.microsoft.com/v1.0/communications/onlineMeetings?$filter=${filter}&$top=1`,
    `https://graph.microsoft.com/beta/me/onlineMeetings?$filter=${filter}&$top=1`,
    `https://graph.microsoft.com/beta/communications/onlineMeetings?$filter=${filter}&$top=1`,
  ];

  for (const url of urlsToTry) {
    try {
      const data = await graphGET(accessToken, url);
      const hit = Array.isArray(data.value) && data.value.length ? data.value[0] : null;
      if (hit && hit.id) return hit;
    } catch (e) {
      // try next
    }
  }

  return null;
}

// List transcripts for an OnlineMeeting (beta is commonly required)
async function listTranscripts(accessToken, onlineMeetingId) {
  const urlsToTry = [
    `https://graph.microsoft.com/beta/communications/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`,
    `https://graph.microsoft.com/beta/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`,
  ];

  for (const url of urlsToTry) {
    try {
      const data = await graphGET(accessToken, url);
      return Array.isArray(data.value) ? data.value : [];
    } catch (e) {
      // try next
    }
  }
  return [];
}

// Get transcript content (try text/vtt)
async function getTranscriptVtt(accessToken, onlineMeetingId, transcriptId) {
  const urlsToTry = [
    `https://graph.microsoft.com/beta/communications/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`,
    `https://graph.microsoft.com/beta/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`,
  ];

  for (const url of urlsToTry) {
    try {
      return await graphGETText(accessToken, url);
    } catch (e) {
      // try next
    }
  }
  throw new Error('Transcript content not available in VTT format.');
}

module.exports = {
  getEvent,
  findOnlineMeetingByJoinUrl,
  listTranscripts,
  getTranscriptVtt,
};
