/**
 * 打卡（Task 06，客户 2026-10-14 确认），纯函数：不读写表格，Apps Script 和 Node 测试里都能运行。
 *
 * 规则：
 * - 某个费城日期“已打卡” = 这一天新建过任何一笔账目（手动或自动入账），按账目的创建时间 created_at 换算成费城日期，
 *   不按交易日期。之后删除或彻底清除这笔账目，打卡都保留（checkins 表只增不减）。
 * - 累计打卡 = 打卡天数；连续打卡 = 截止今天（今天还没打卡时截止昨天）连续打卡的天数。
 * - 里程碑（累计天数）：1、3、7、14、30、50、100、200、365，之后每 100 天：400、500、600 ……
 */

var CHECKIN_BASE_MILESTONES = [1, 3, 7, 14, 30, 50, 100, 200, 365];
var WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 账目创建时间（UTC ISO）→ 打卡日期（费城 'YYYY-MM-DD'）；无法识别返回 null。 */
function checkinDateOf(createdAtIso) {
  if (!createdAtIso) return null;
  var d = new Date(createdAtIso);
  if (isNaN(d.getTime())) return null;
  return dateNY(d);
}

function isDateString_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

/** 'YYYY-MM-DD' 加减若干天（纯日历计算，与时区无关）。 */
function addDaysNY(date, delta) {
  var t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + delta * DAY_MS;
  var d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** 星期几：0 = 周一 … 6 = 周日。 */
function weekdayIndexNY(date) {
  var w = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))).getUTCDay();
  return (w + 6) % 7;
}

/** n 是不是里程碑。 */
function isCheckinMilestone(n) {
  if (!(n >= 1) || Math.floor(n) !== n) return false;
  if (CHECKIN_BASE_MILESTONES.indexOf(n) >= 0) return true;
  return n >= 400 && n % 100 === 0;
}

/** 已达到的最高里程碑（≤ n）；一个都没有返回 null。 */
function highestMilestoneReached(n) {
  if (!(n >= 1)) return null;
  if (n >= 400) return Math.floor(n / 100) * 100;
  var best = null;
  CHECKIN_BASE_MILESTONES.forEach(function (m) { if (m <= n) best = m; });
  return best;
}

/** 下一个里程碑（> n）。 */
function nextCheckinMilestone(n) {
  var c = Math.max(0, Math.floor(n || 0));
  for (var i = 0; i < CHECKIN_BASE_MILESTONES.length; i++) if (CHECKIN_BASE_MILESTONES[i] > c) return CHECKIN_BASE_MILESTONES[i];
  return Math.max(400, (Math.floor(c / 100) + 1) * 100);
}

/**
 * 打卡概况（我的页、小助手用）。dates：打卡日期数组（可重复、可无序）；today：费城今天 'YYYY-MM-DD'。
 * 返回 {cumulative, streak, checked_today, week: [{date, label, checked, is_today, future}], next_milestone, days_to_next}
 */
function checkinSummary(dates, today) {
  var set = {};
  var cumulative = 0;
  (dates || []).forEach(function (d) {
    if (!isDateString_(d) || d > today || set[d]) return;   // 日期在“今天”之后的行不应存在；防御性地不计入
    set[d] = true;
    cumulative++;
  });
  var checkedToday = !!set[today];
  var streak = 0;
  var cursor = checkedToday ? today : addDaysNY(today, -1);
  while (set[cursor]) { streak++; cursor = addDaysNY(cursor, -1); }
  var monday = addDaysNY(today, -weekdayIndexNY(today));
  var week = [];
  for (var i = 0; i < 7; i++) {
    var day = addDaysNY(monday, i);
    week.push({ date: day, label: WEEKDAY_LABELS[i], checked: !!set[day], is_today: day === today, future: day > today });
  }
  var next = nextCheckinMilestone(cumulative);
  return {
    cumulative: cumulative,
    streak: streak,
    checked_today: checkedToday,
    week: week,
    next_milestone: next,
    days_to_next: next - cumulative
  };
}

/**
 * 补打卡（setupLedger 用）：根据账目的创建时间算出“应有的打卡日期”，只返回表里还没有的那些行
 * （每天取最早的 created_at），按日期排序。已删除但还没被清除的账目也算（它们当初确实被新建过）。
 */
function planCheckinBackfill(entries, existingRows) {
  var have = {};
  (existingRows || []).forEach(function (r) { if (r && r.date_ny) have[r.date_ny] = true; });
  var first = {};
  (entries || []).forEach(function (e) {
    var day = checkinDateOf(e.created_at);
    if (!day || have[day]) return;
    var iso = new Date(e.created_at).toISOString();
    if (!first[day] || iso < first[day]) first[day] = iso;
  });
  return Object.keys(first).sort().map(function (day) { return { date_ny: day, first_entry_at: first[day] }; });
}
