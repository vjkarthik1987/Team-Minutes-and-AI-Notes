const User = require('../models/User');
const { generateExecutiveBriefForUser } = require('../services/executiveBrief.service');
let timer = null;
function msUntilNextSixIST() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const next = new Date(ist); next.setHours(6,0,0,0); if (ist >= next) next.setDate(next.getDate() + 1);
  return Math.max(60000, next - ist);
}
async function runDailyExecutiveBrief() {
  const users = await User.find({ status: { $ne: 'disabled' } }).populate('org').limit(500);
  for (const user of users) {
    try { if (user.org) await generateExecutiveBriefForUser({ user, force: true }); }
    catch (e) { console.error('[v20 daily brief failed]', user.email, e.message); }
  }
}
function startDailyExecutiveBriefScheduler() {
  if (timer || String(process.env.START_EMBEDDED_WORKERS || 'true').toLowerCase() === 'false') return;
  const schedule = () => { timer = setTimeout(async () => { await runDailyExecutiveBrief().catch(e => console.error(e)); schedule(); }, msUntilNextSixIST()); };
  schedule();
}
module.exports = { startDailyExecutiveBriefScheduler, runDailyExecutiveBrief };
