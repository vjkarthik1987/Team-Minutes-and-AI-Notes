// utils/graph.js
const fetch = require('node-fetch');

async function getCalendarRange(accessToken, { startDateTime, endDateTime, top = 75, max = 300 } = {}) {
  const base = new URL('https://graph.microsoft.com/v1.0/me/calendarView');
  base.searchParams.set('startDateTime', startDateTime);
  base.searchParams.set('endDateTime', endDateTime);
  base.searchParams.set('$orderby', 'start/dateTime');
  base.searchParams.set('$top', String(top));
  base.searchParams.set('$select', [
    'id',
    'subject',
    'start',
    'end',
    'location',
    'organizer',
    'attendees',  
    'isCancelled',
    'onlineMeetingUrl',
    'onlineMeeting'
  ].join(','));

  let url = base.toString();
  const all = [];

  while (url && all.length < max) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="Asia/Kolkata"',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph calendarView failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    const page = Array.isArray(json.value) ? json.value : [];

    for (const ev of page) {
      if (!ev.isCancelled) all.push(ev);
      if (all.length >= max) break;
    }

    url = json['@odata.nextLink'] || null;
  }

  return all;
}

module.exports = { getCalendarRange };
