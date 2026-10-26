/**
 * 小助手（spec 7A.3 / 7A.4，PRD 6A.2–6A.4；Task 06 新增打卡里程碑和超支速度提醒），纯函数。
 *
 * 三层（界面只认“消息”，不认规则）：
 *   账本数据 ──> buildSnapshot(data, now)  只含按月、按类别的汇总、预算、储蓄估算、待处理笔数、打卡、日期信息；
 *                                          不含商家、备注、邮件等原始内容
 *            ──> 技能注册表 ASSISTANT_SKILLS  每个技能 { id, kind: 'reminder' | 'question', label?, evaluate / answer }
 *            ──> 消息 { skill_id, text, items?: [{label, amount_cents}], action?, dedup_key, once? }
 * 提醒类技能：evaluate(snapshot, state) -> { messages[], newState }（state 是 assistant_state 的键值）。
 * 问题类技能：answer(snapshot) -> 消息；即时计算，不保存，不产生红点。
 * 加一个按钮或一种提醒 = 在下面的注册表里加一项；界面和存储都不用改。
 *
 * 去重：
 *   - “状态变化才提醒”的技能（预算接近/超出、待处理）把状态写进 newState；
 *   - “只发一次”的技能（进度良好、上月表扬、超支速度、打卡里程碑、限流）给消息加 once: true，
 *     引擎把 dedup_key 记进 assistant_state（不清理），所以 90 天后消息被清理也不会再发一遍。
 * 所有金额都是整数美分，比较全部用整数乘法。
 */

var GOOD_PROGRESS_MARGIN_KEY = 'good_progress_margin_pts';
var GOOD_PROGRESS_MARGIN_DEFAULT = 15;
var ASSISTANT_SHOW_DAYS = 30;     // 对话窗口显示最近 30 天（D11）
var ASSISTANT_KEEP_DAYS = 90;     // 每日清理删除 90 天前的消息（D11）
var BUDGET_PACE_FROM_DAY = 7;     // 超支速度提醒：从每月 7 日起

/** 用开心表情头像的消息（夸奖、里程碑）；其余用普通表情。 */
var ASSISTANT_HAPPY_SKILLS = { good_progress: true, last_month_praise: true, checkin_milestone: true };
function assistantMood(skillId) {
  return ASSISTANT_HAPPY_SKILLS[skillId] ? 'happy' : 'normal';
}

/** 四舍五入的整数除法（0.5 进位），a ≥ 0、b > 0。 */
function roundDiv_(a, b) {
  return Math.floor((2 * a + b) / (2 * b));
}
function usd_(cents) { return (cents < 0 ? '-$' : '$') + formatCents(Math.abs(cents)); }   // 负数写成 -$579.60
function monthNum_(month) { return +month.slice(5, 7); }

function readMarginPts(settingsRows) {
  var v = null;
  (settingsRows || []).forEach(function (r) { if (r.key === GOOD_PROGRESS_MARGIN_KEY) v = r.value; });
  var s = v === null || v === undefined ? '' : String(v).trim();
  if (!/^\d{1,2}$/.test(s)) return GOOD_PROGRESS_MARGIN_DEFAULT;
  return Number(s);
}

/**
 * 待补全 / 待核对笔数：本月及以前所有未删除的账目（spec 7A.2 按钮 5）。mail = D16“待查看邮件”数，由 buildSnapshot 填入。
 */
function attentionCounts(entries, currentMonth) {
  var pending = 0, review = 0;
  (entries || []).forEach(function (e) {
    if (!isLive(e) || !e.month_ny || e.month_ny > currentMonth) return;
    var st = entryStatus(e);
    if (st === STATUS.PENDING) pending++;
    else if (st === STATUS.AMOUNT_REVIEW || st === STATUS.DUP_REVIEW) review++;
  });
  return { pending: pending, review: review, mail: 0, total: pending + review };
}

/**
 * 有待补全 / 待核对账目的月份清单（本月及以前），按月份从早到晚，规则与 attentionCounts 完全一致，
 * 各月 count 之和 = attentionCounts(...).total。“去处理”用它找最早的月份，账目页用它提示其他月份。
 */
function attentionMonths(entries, currentMonth) {
  var byMonth = {};
  (entries || []).forEach(function (e) {
    if (!isLive(e) || !e.month_ny || e.month_ny > currentMonth) return;
    if (entryStatus(e) === STATUS.NORMAL) return;
    byMonth[e.month_ny] = (byMonth[e.month_ny] || 0) + 1;
  });
  return Object.keys(byMonth).sort().map(function (m) { return { month: m, count: byMonth[m] }; });
}

function rowsSummary_(rows) {
  return rows.map(function (r) { return { name: r.name, cents: r.cents, percent_tenths: r.percent_tenths }; });
}

/**
 * 快照：规则和问题只看这里的数据。data = {entries, categories, budgets, settings, checkins, rate_limited_markers, pending_mail_count, savings_forecast}。
 * 注意：这里只放汇总数字、类别名称和日期，绝不放商家、备注或任何原始账目。
 */
function buildSnapshot(data, now) {
  var entries = data.entries || [];
  var categories = data.categories || [];
  var budgets = data.budgets || [];
  var sources = [];
  var p = nyParts(now);
  var month = monthNY(now);
  var today = dateNY(now);
  var L = daysInMonth(month);
  var prev = addMonths(month, -1);
  var prevL = daysInMonth(prev);
  var nearPct = readNearPct(data.settings);

  // 本月到今天：month_ny = 本月 且 date_ny ≤ 今天（提前录入的以后日期不计入）
  var mtdRep = computeReport(entries.filter(function (e) { return e.month_ny === month && e.date_ny && e.date_ny <= today; }),
    categories, sources, month);
  // 上月同期：上月 1 日至第 min(d, 上月天数) 天
  var prevEnd = Math.min(p.d, prevL);
  var prevEndDate = prev + '-' + pad2_(prevEnd);
  var prevRep = computeReport(entries.filter(function (e) { return e.month_ny === prev && e.date_ny && e.date_ny <= prevEndDate; }),
    categories, sources, prev);

  var prevBudget = effectiveBudget(budgets, BUDGET_TOTAL, prev);
  var prevUsage = budgetUsage(entries, BUDGET_TOTAL, prev);

  return {
    now_iso: now.toISOString(),
    today: today,
    month: month,
    d: p.d,
    L: L,
    days_left: L - p.d,
    prev_month: prev,
    prev_L: prevL,
    near_pct: nearPct,
    margin_pts: readMarginPts(data.settings),
    budget: computeBudgetView(entries, categories, budgets, month, nearPct),
    prev_budget: { budget_cents: prevBudget, used_cents: prevUsage.used_cents, pending_count: prevUsage.pending_count },
    attention: Object.assign(attentionCounts(entries, month), { mail: Math.max(0, Number(data.pending_mail_count) || 0) }),
    mtd: {
      expense_cents: mtdRep.expense.total_cents,
      income_cents: mtdRep.income.total_cents,
      diff_cents: mtdRep.comparison.diff_cents,
      expense_rows: rowsSummary_(mtdRep.expense.rows),
      income_rows: rowsSummary_(mtdRep.income.rows),
      pending_count: mtdRep.pending_count
    },
    prev_same: {
      end_day: prevEnd,
      full_month: p.d > prevL,
      expense_cents: prevRep.expense.total_cents,
      pending_count: prevRep.pending_count
    },
    checkin: data.checkins ? checkinSummary(data.checkins.map(function (r) { return r.date_ny; }), today) : null,
    rate_limited_markers: (data.rate_limited_markers || []).slice(),
    savings: assistantSavingsSummary_(data.savings_forecast)
  };
}

/** 只挑选提醒需要的汇总字段；不传入目标名称、存入明细或历史账目。 */
function assistantSavingsSummary_(forecast) {
  if (!forecast) return null;
  return {
    month: forecast.month,
    can_estimate: forecast.can_estimate,
    active_goal_count: forecast.active_goal_count,
    planned_savings_cents: forecast.planned_savings_cents,
    monthly_savings_capacity_cents: forecast.monthly_savings_capacity_cents,
    over_capacity: forecast.over_capacity,
    over_capacity_cents: forecast.over_capacity_cents,
    incomplete: forecast.incomplete,
    pending_count: forecast.pending_count
  };
}

/** 规则和消息可见性共用同一条件，避免目标已调好后仍显示旧提醒。 */
function savingsAffordabilityEligible_(forecast, month) {
  return !!forecast && forecast.month === month && forecast.can_estimate === true &&
    forecast.active_goal_count > 0 && forecast.over_capacity === true;
}

// ======================= 提醒类技能 =======================

function budgetScopeKey_(month, scope) {
  return 'budget:' + month + ':' + (scope === BUDGET_TOTAL ? 'total' : 'cat:' + scope);
}
function pendingNote_(n) {
  return n > 0 ? '（有 ' + n + ' 笔未补全，预算统计不完整）' : '';
}

/** 预算接近 / 超出（spec 7A.3）：共用状态键 budget:<月>:<范围>，值为 none / near / over。 */
function evaluateBudgetAlerts_(snap, state) {
  var view = snap.budget, out = [], newState = {};
  var prefix = 'budget:' + snap.month + ':';
  var seen = {};
  var items = (view.total ? [view.total] : []).concat(view.categories);
  items.forEach(function (it) {
    var key = budgetScopeKey_(snap.month, it.scope);
    seen[key] = true;
    var cur = it.state === 'ok' ? 'none' : it.state;
    var prev = state[key] || 'none';
    if (cur === prev) return;
    newState[key] = cur;
    var name = it.scope === BUDGET_TOTAL ? '总预算' : it.name;
    var rows = [{ label: '预算', amount_cents: it.budget_cents }, { label: '已用', amount_cents: it.used_cents }];
    if (cur === 'near' && prev === 'none') {
      out.push({
        skill_id: 'budget_near', dedup_key: key + ':near@' + snap.now_iso, items: rows,
        text: name + '已用 ' + it.used_pct + '%，' + (snap.days_left > 0 ? '本月还剩 ' + snap.days_left + ' 天' : '今天是本月最后一天') +
          '，注意一下哦' + pendingNote_(it.pending_count)
      });
    } else if (cur === 'over') {
      out.push({
        skill_id: 'budget_over', dedup_key: key + ':over@' + snap.now_iso, items: rows,
        text: (it.scope === BUDGET_TOTAL ? '本月总预算已超出 ' : name + '本月已超出预算 ') + usd_(-it.remaining_cents) + pendingNote_(it.pending_count)
      });
    }
    // over → near、回到 none：只更新状态，不发消息
  });
  // 预算被取消（或类别被删除）的范围：状态回到 none，以后重新设置后再接近时会再提醒
  Object.keys(state).forEach(function (k) {
    if (k.indexOf(prefix) === 0 && !seen[k] && state[k] !== 'none') newState[k] = 'none';
  });
  return { messages: out, newState: newState };
}

/** 进度良好（D8）：月中以后、已用比例 ≤ 时间进度 − margin 个百分点、本月没有待补全；每月一次。 */
function evaluateGoodProgress_(snap) {
  var t = snap.budget.total;
  if (!t || !(2 * snap.d > snap.L) || snap.budget.pending_count > 0) return { messages: [] };
  // used/budget ≤ d/L − margin/100  ⇔  used × 100 × L ≤ (100 × d − margin × L) × budget
  if (t.used_cents * 100 * snap.L > (100 * snap.d - snap.margin_pts * snap.L) * t.budget_cents) return { messages: [] };
  var timePct = roundDiv_(snap.d * 100, snap.L);
  return { messages: [{
    skill_id: 'good_progress', once: true, dedup_key: 'good_progress:' + snap.month,
    text: '本月已经过去 ' + timePct + '%，总预算才用了 ' + t.used_pct + '%，保持得很好！'
  }] };
}

/** 上月表扬（D12）：进入新月份后第一次运行规则时检查一次上月。 */
function evaluateLastMonthPraise_(snap, state) {
  var checkedKey = 'last_month_praise:checked:' + snap.prev_month;
  if (state[checkedKey]) return { messages: [] };
  var newState = {};
  newState[checkedKey] = snap.today;
  var pb = snap.prev_budget, out = [];
  if (pb.budget_cents !== null && pb.used_cents <= pb.budget_cents) {
    var saved = pb.budget_cents - pb.used_cents;
    out.push({
      skill_id: 'last_month_praise', once: true, dedup_key: 'last_month_praise:' + snap.prev_month, month: snap.prev_month,
      items: [{ label: monthNum_(snap.prev_month) + ' 月预算', amount_cents: pb.budget_cents }, { label: monthNum_(snap.prev_month) + ' 月支出', amount_cents: pb.used_cents }],
      text: (saved > 0 ? '上个月（' + monthNum_(snap.prev_month) + ' 月）比预算少花了 ' + usd_(saved) + '，做得好！'
        : '上个月（' + monthNum_(snap.prev_month) + ' 月）刚好用完预算，没有超支，做得好！') +
        (pb.pending_count > 0 ? '（上个月还有 ' + pb.pending_count + ' 笔未补全，结论可能变化）' : '')
    });
  }
  return { messages: out, newState: newState };
}

/** 待处理（spec 7A.3）：笔数超过上次发送时的笔数、且今天还没发过才发；笔数归零时重置。 */
function evaluatePendingItems_(snap, state) {
  var a = snap.attention;
  var lastCount = Number(state['pending:last_sent_count'] || 0) || 0;
  var lastDate = state['pending:last_sent_date'] || '';
  if (a.total + a.mail === 0) {
    return lastCount !== 0 ? { messages: [], newState: { 'pending:last_sent_count': '0' } } : { messages: [] };
  }
  var count = a.total + a.mail;
  if (!(count > lastCount) || lastDate === snap.today) return { messages: [] };
  var parts = [];
  if (a.pending) parts.push(a.pending + ' 笔金额没补全');
  if (a.review) parts.push(a.review + ' 笔待核对');
  if (a.mail) parts.push(a.mail + ' 封待查看邮件');
  return {
    messages: [{ skill_id: 'pending_items', dedup_key: 'pending:' + snap.today,
      text: '还有 ' + parts.join('、') + '，补上后预算统计会更准哦' +
        (a.mail ? '（名单外的邮件不会自动记账；请到“我的 → 待查看邮件”选择怎么处理）' : ''),
      action: a.mail ? 'goto:mail_pending' : 'goto:pending' }],
    newState: { 'pending:last_sent_count': String(count), 'pending:last_sent_date': snap.today }
  };
}

/**
 * Apple Pay 被限流（spec 5.3、7A.3）：每个标记行一条消息，键 rate_limited:<标记时间>。
 * 标记 = {at, count}（count = 被拒笔数）。状态键 rate_limited_n:<标记时间> 记着上次告诉你的笔数：
 * 笔数变多时发出 upsert 消息——引擎会更新原来那条消息里的 N，并把它重新设为未读（红点再次出现）。
 * 也接受只有时间的旧格式（字符串），此时只提醒一次。
 */
function evaluateRateLimited_(snap, state) {
  var out = [], newState = {};
  snap.rate_limited_markers.forEach(function (mk) {
    var at = typeof mk === 'string' ? mk : mk && mk.at;
    if (!at) return;
    var count = typeof mk === 'string' ? null : Math.floor(Number(mk.count)) || null;
    var countKey = 'rate_limited_n:' + at;
    var cur = count === null ? '?' : String(count);
    if (state[countKey] === cur) return;
    if (count !== null && state[countKey] && Number(state[countKey]) >= count) return;   // 只在变多时提醒
    newState[countKey] = cur;
    out.push({ skill_id: 'apple_pay_rate_limited', upsert: true, dedup_key: 'rate_limited:' + at,
      text: count === null ? 'Apple Pay 自动记账刚才太频繁被暂停了一会儿，可能有交易没记上，记得核对一下哦'
        : '喵～' + rateLimitedText(at, count) + '哦' });
  });
  return { messages: out, newState: newState };
}

/** 打卡里程碑：只看已达到的最高里程碑；同时跨过几个时只发最高的那一个。 */
var CHECKIN_MILESTONE_TEXT = {
  1: '喵～第一次打卡成功！从今天起，我陪你一起记账。',
  3: '累计打卡 3 天啦，好习惯正在悄悄发芽～',
  7: '累计打卡 7 天！一整周都有你认真记账的身影，真棒。',
  14: '累计打卡 14 天，两周坚持下来，小猫为你鼓掌！',
  30: '喵～累计打卡 30 天！记账已经成了你的小习惯啦。',
  50: '累计打卡 50 天，半百达成！账本越来越清楚了。',
  100: '累计打卡 100 天！一百天的坚持，值得一个大大的抱抱。',
  200: '累计打卡 200 天，你是小猫见过最有耐心的记账人。',
  365: '喵～累计打卡 365 天！整整一年的陪伴，谢谢你一直都在。'
};
function checkinMilestoneText(n) {
  return CHECKIN_MILESTONE_TEXT[n] || ('累计打卡 ' + n + ' 天！又一个一百天，我们继续一起加油～');
}
function evaluateCheckinMilestone_(snap) {
  if (!snap.checkin) return { messages: [] };
  var m = highestMilestoneReached(snap.checkin.cumulative);
  if (!m) return { messages: [] };
  return { messages: [{ skill_id: 'checkin_milestone', once: true, dedup_key: 'checkin:' + m, text: checkinMilestoneText(m) }] };
}

/**
 * 超支速度（客户 2026-10-14）：只看总预算；每月 7 日起；还没超出；按目前日均支出推算月底支出
 * 已用 ÷ d × L > 预算（整数：已用 × L > 预算 × d）时提醒；每月最多一次。
 */
function evaluateBudgetPace_(snap) {
  var t = snap.budget.total;
  if (!t || snap.d < BUDGET_PACE_FROM_DAY || t.state === 'over' || t.used_cents <= 0) return { messages: [] };
  if (!(t.used_cents * snap.L > t.budget_cents * snap.d)) return { messages: [] };
  var dailyBudget = roundDiv_(t.budget_cents, snap.L);
  var dailyUsed = roundDiv_(t.used_cents, snap.d);
  return { messages: [{
    skill_id: 'budget_pace', once: true, dedup_key: 'budget_pace:' + snap.month,
    items: [{ label: '每日平均预算', amount_cents: dailyBudget }, { label: '目前日均支出', amount_cents: dailyUsed },
      { label: '照这个速度月底约', amount_cents: roundDiv_(t.used_cents * snap.L, snap.d) }],
    text: '喵～本月每日平均预算 ' + usd_(dailyBudget) + '，目前日均支出 ' + usd_(dailyUsed) + '，照这个速度月底可能会超支哦'
  }] };
}

/** 同月只保留一条储蓄提醒；显示金额变化才更新，恢复可负担后不再显示。 */
function evaluateSavingsAffordability_(snap, state) {
  var s = snap.savings;
  var eligible = savingsAffordabilityEligible_(s, snap.month);
  var stateKey = 'savings_affordability_state:' + snap.month;
  var signature = eligible ? ['over', s.planned_savings_cents, s.monthly_savings_capacity_cents,
    s.over_capacity_cents, s.incomplete ? 'incomplete' : 'complete', s.pending_count].join(':') : 'inactive';
  // 没有发过提醒的旧账本和空目标，不必增加状态行。
  if (state[stateKey] === signature || (!eligible && !Object.prototype.hasOwnProperty.call(state, stateKey))) {
    return { messages: [] };
  }
  var newState = {};
  newState[stateKey] = signature;
  if (!eligible) return { messages: [], newState: newState };
  var text = '喵～按本月账本估算，扣除预计花费后可存 ' + usd_(s.monthly_savings_capacity_cents) +
    '，全部目标每月计划存 ' + usd_(s.planned_savings_cents) + '，多出了 ' + usd_(s.over_capacity_cents) +
    '。照现在的安排，目标可能要攒更久喵。要不要降低每月存款、换个小一点的目标，或把目标日期往后调一调呀？';
  if (s.incomplete) text += '还有 ' + s.pending_count + ' 笔账目金额未补全，估算不完整，补全后可能变化。';
  return {
    messages: [{ skill_id: 'savings_affordability', upsert: true, dedup_key: 'savings_affordability:' + snap.month,
      text: text, action: 'goto:savings', items: [
        { label: '全部目标月度存款', amount_cents: s.planned_savings_cents },
        { label: '预计每月可存', amount_cents: s.monthly_savings_capacity_cents },
        { label: '超出预计可存金额', amount_cents: s.over_capacity_cents }
      ] }],
    newState: newState
  };
}

// ======================= 问题类技能（按钮，PRD 6A.4 的顺序） =======================

function mdLabel_(date) { return (+date.slice(5, 7)) + ' 月 ' + (+date.slice(8, 10)) + ' 日'; }

function answerMonthToDate_(s) {
  var m = s.mtd;
  var items = m.expense_rows.map(function (r) { return { label: '支出 · ' + r.name, amount_cents: r.cents }; })
    .concat(m.income_rows.map(function (r) { return { label: '收入 · ' + r.name, amount_cents: r.cents }; }));
  var text = '本月 1 日到今天（' + mdLabel_(s.today) + '）：支出 ' + usd_(m.expense_cents) + '，收入 ' + usd_(m.income_cents) +
    '，差额 ' + usd_(m.diff_cents) + '。';
  if (!items.length && !m.pending_count) text = '本月 1 日到今天（' + mdLabel_(s.today) + '）还没有记录。';
  if (m.pending_count) text += '有 ' + m.pending_count + ' 笔未补全，统计不完整。';
  return { text: text, items: items };
}

function answerBudgetLeft_(s) {
  var v = s.budget;
  if (!v.has_any) return { text: '本月还没有设置预算，可以在“预算”页设置一个每月总预算哦。' };
  var parts = [];
  if (v.total) parts.push(v.total.remaining_cents < 0 ? '总预算已超出 ' + usd_(-v.total.remaining_cents) : '总预算还能花 ' + usd_(v.total.remaining_cents));
  else parts.push('还没有设置总预算');
  var items = (v.total ? [v.total] : []).concat(v.categories).map(function (it) {
    var over = it.remaining_cents < 0;
    return { label: (it.scope === BUDGET_TOTAL ? '总预算' : it.name) + (over ? '（超出）' : '（剩余）'), amount_cents: Math.abs(it.remaining_cents) };
  });
  var text = parts.join('，') + '，' + (s.days_left > 0 ? '本月还剩 ' + s.days_left + ' 天。' : '今天是本月最后一天。');
  if (v.pending_count) text += '有 ' + v.pending_count + ' 笔未补全，预算统计不完整。';
  return { text: text, items: items };
}

function answerTopCategory_(s) {
  var rows = s.mtd.expense_rows.filter(function (r) { return r.cents > 0; });
  if (!rows.length) return { text: '本月还没有支出记录。' };
  var max = rows[0].cents;
  rows.forEach(function (r) { if (r.cents > max) max = r.cents; });
  var top = rows.filter(function (r) { return r.cents === max; });
  var text = top.length === 1
    ? '本月到今天花得最多的是“' + top[0].name + '”，共 ' + usd_(max) + (top[0].percent_tenths !== null ? '，占支出 ' + formatPercentTenths(top[0].percent_tenths) : '') + '。'
    : top.map(function (r) { return '“' + r.name + '”'; }).join('、') + '并列最多，各 ' + usd_(max) + '。';
  if (s.mtd.pending_count) text += '有 ' + s.mtd.pending_count + ' 笔未补全，结果可能变化。';
  return { text: text, items: top.map(function (r) { return { label: r.name, amount_cents: r.cents }; }) };
}

function answerVsLastMonth_(s) {
  var cur = s.mtd.expense_cents, prev = s.prev_same.expense_cents, diff = cur - prev;
  var pm = monthNum_(s.prev_month);
  var text = '本月 1–' + s.d + ' 日支出 ' + usd_(cur) + '；上月同期（' + pm + ' 月 1–' + s.prev_same.end_day + ' 日）支出 ' + usd_(prev) + '。';
  if (diff === 0) text += '和上月同期持平。';
  else {
    text += (diff > 0 ? '多花了 ' : '少花了 ') + usd_(Math.abs(diff));
    if (prev > 0) text += '（' + (diff > 0 ? '+' : '−') + formatPercentTenths(percentTenths(Math.abs(diff), prev)) + '）';
    text += '。';
  }
  if (s.prev_same.full_month) text += '上月只有 ' + s.prev_L + ' 天，已与上月全月比较。';
  if (s.mtd.pending_count) text += '本月有 ' + s.mtd.pending_count + ' 笔未补全。';
  if (s.prev_same.pending_count) text += '上月同期有 ' + s.prev_same.pending_count + ' 笔未补全。';
  return { text: text, items: [{ label: '本月 1–' + s.d + ' 日', amount_cents: cur }, { label: pm + ' 月 1–' + s.prev_same.end_day + ' 日', amount_cents: prev }] };
}

function answerPending_(s) {
  var a = s.attention;
  if (a.total + a.mail === 0) return { text: '没有待补全或待核对的账目，账本很整齐！' };
  var parts = [];
  if (a.pending) parts.push(a.pending + ' 笔待补全');
  if (a.review) parts.push(a.review + ' 笔待核对');
  if (a.mail) parts.push(a.mail + ' 封待查看邮件');
  return { text: '本月及以前还有 ' + parts.join('、') + '，点下面的按钮去处理吧。' +
    (a.mail ? '名单商家按规则自动记账；名单外邮件不会自动记账，可在“我的 → 待查看邮件”选择手动记、以后自动记、静音或标为已查看。' : ''),
    action: a.mail ? 'goto:mail_pending' : 'goto:pending' };
}

// ======================= 注册表 =======================

var ASSISTANT_SKILLS = [
  { id: 'budget_alerts', kind: 'reminder', evaluate: evaluateBudgetAlerts_ },     // 发 budget_near / budget_over
  { id: 'budget_pace', kind: 'reminder', evaluate: evaluateBudgetPace_ },
  { id: 'savings_affordability', kind: 'reminder', evaluate: evaluateSavingsAffordability_ },
  { id: 'good_progress', kind: 'reminder', evaluate: evaluateGoodProgress_ },
  { id: 'last_month_praise', kind: 'reminder', evaluate: evaluateLastMonthPraise_ },
  { id: 'pending_items', kind: 'reminder', evaluate: evaluatePendingItems_ },
  { id: 'apple_pay_rate_limited', kind: 'reminder', evaluate: evaluateRateLimited_ },
  { id: 'checkin_milestone', kind: 'reminder', evaluate: evaluateCheckinMilestone_ },
  { id: 'q_month_to_date', kind: 'question', label: '本月到今天的收支', answer: answerMonthToDate_ },
  { id: 'q_budget_left', kind: 'question', label: '这个月还能花多少？', answer: answerBudgetLeft_ },
  { id: 'q_top_category', kind: 'question', label: '哪个类别花得最多？', answer: answerTopCategory_ },
  { id: 'q_vs_last_month', kind: 'question', label: '跟上个月同期比怎么样？', answer: answerVsLastMonth_ },
  { id: 'q_pending', kind: 'question', label: '还有几笔没补全／待核对？', answer: answerPending_ }
];

function assistantQuestions() {
  return ASSISTANT_SKILLS.filter(function (s) { return s.kind === 'question'; }).map(function (s) { return { id: s.id, label: s.label }; });
}

/**
 * 运行全部提醒类技能。stateMap：assistant_state 当前的键值。
 * 返回 {messages: 要保存的新消息, changes: 要写入 assistant_state 的键值}。同样的输入运行多次，结果相同（幂等由状态保证）。
 */
function runSkills(snapshot, stateMap, skills) {
  var view = Object.assign({}, stateMap || {});
  var changes = {};
  var messages = [];
  (skills || ASSISTANT_SKILLS).forEach(function (skill) {
    if (skill.kind !== 'reminder') return;
    var res = skill.evaluate(snapshot, view) || {};
    (res.messages || []).forEach(function (m) {
      if (m.once) {
        if (view[m.dedup_key]) return;          // 已经发过
        view[m.dedup_key] = snapshot.now_iso;
        changes[m.dedup_key] = snapshot.now_iso;
      }
      messages.push({
        skill_id: m.skill_id || skill.id,
        dedup_key: m.dedup_key,
        month: m.month || snapshot.month,
        text: m.text,
        items: m.items || [],
        action: m.action || null,
        once: !!m.once,
        upsert: !!m.upsert
      });
    });
    Object.keys(res.newState || {}).forEach(function (k) {
      view[k] = res.newState[k];
      changes[k] = res.newState[k];
    });
  });
  return { messages: messages, changes: changes };
}

/** 问题按钮的回答（即时计算，不保存）。 */
function answerQuestion(id, snapshot) {
  var skill = ASSISTANT_SKILLS.filter(function (s) { return s.kind === 'question' && s.id === id; })[0];
  if (!skill) throw UserError('没有这个问题');
  var a = skill.answer(snapshot);
  return { skill_id: id, question: skill.label, text: a.text, items: a.items || [], action: a.action || null, mood: 'normal' };
}
