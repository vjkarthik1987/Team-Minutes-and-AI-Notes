const AuditLog = require('../models/AuditLog');
const Org = require('../models/Org');
const { sweepOnce } = require('../workers/transcriptSweep.worker');

let timer = null;
let running = false;

function msUntilNextIst(hour = 0, minute = 5) {
  const now = new Date();
  const istNowMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const istNow = new Date(istNowMs);
  const targetIst = new Date(istNow);
  targetIst.setUTCHours(hour, minute, 0, 0);
  if (targetIst.getTime() <= istNow.getTime()) targetIst.setUTCDate(targetIst.getUTCDate() + 1);
  return Math.max(1000, targetIst.getTime() - istNow.getTime());
}

async function writeOrgAudit(summary, metadata = {}) {
  const orgs = await Org.find({}).select({ _id:1 }).lean();
  await Promise.all(orgs.map(org => AuditLog.create({
    orgId: org._id,
    action: 'DAILY_CALENDAR_REFRESH',
    entityType: 'SystemJob',
    entityId: 'daily-calendar-refresh-0005-ist',
    summary,
    metadata,
  }).catch(() => null)));
}

async function runDailyCalendarRefresh() {
  if (running) return;
  running = true;
  const startedAt = new Date();
  try {
    await writeOrgAudit('Daily 12:05 AM IST calendar/transcript refresh started', { startedAt });
    const stats = await sweepOnce();
    await writeOrgAudit('Daily 12:05 AM IST calendar/transcript refresh completed', { startedAt, completedAt: new Date(), stats });
  } catch (e) {
    await writeOrgAudit('Daily 12:05 AM IST calendar/transcript refresh failed', { startedAt, failedAt: new Date(), error: e.message || String(e) });
    console.warn('[daily-calendar-refresh] failed:', e.message || String(e));
  } finally {
    running = false;
  }
}

function startDailyCalendarRefreshScheduler() {
  if (String(process.env.ENABLE_DAILY_CALENDAR_REFRESH || 'true').toLowerCase() === 'false') {
    console.log('[daily-calendar-refresh] disabled');
    return;
  }
  const scheduleNext = () => {
    const delay = msUntilNextIst(0, 5);
    timer = setTimeout(async () => {
      await runDailyCalendarRefresh();
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  };
  scheduleNext();
  console.log('[daily-calendar-refresh] scheduled for 12:05 AM IST daily');
}

module.exports = { startDailyCalendarRefreshScheduler, runDailyCalendarRefresh };
