/**
 * 预算规则（PRD 6A.1、spec 7A.1 / 7A.2），纯函数：不读写表格，Apps Script 和 Node 测试里都能运行。
 *
 * 预算历史保存在 budgets 表，每行 {id, scope, amount_cents, effective_from, updated_at}：
 *   - scope：'total'（总预算）或某个支出类别的 id；
 *   - 某月某范围的预算 = effective_from ≤ 该月的行里 effective_from 最大的那一行；金额为空或没有这样的行 = 该月没有这项预算；
 *   - 修改只针对“当前月”（费城时间）：已有当月的行就更新这一行，否则追加一行。过去月份的行永远不改。
 * 所有金额都是整数美分；判断“接近预算”用整数比较 已用×100 ≥ 比例×预算，避免四舍五入误判。
 */

var BUDGET_TOTAL = 'total';
var BUDGET_NEAR_PCT_KEY = 'budget_near_pct';
var BUDGET_NEAR_PCT_DEFAULT = 80;
var BUDGET_NEAR_PCT_MIN = 50;
var BUDGET_NEAR_PCT_MAX = 100;

/** 某月某范围有效的预算金额（美分）；没有预算返回 null。 */
function effectiveBudget(rows, scope, month) {
  var best = null;
  (rows || []).forEach(function (r) {
    if (r.scope !== scope || !r.effective_from || r.effective_from > month) return;
    // 同一个月出现两行时（正常不会发生）取后写入的那一行
    if (!best || r.effective_from >= best.effective_from) best = r;
  });
  if (!best || best.amount_cents === null || best.amount_cents === undefined) return null;
  return best.amount_cents;
}

/**
 * 计划一次预算修改（amountCents 为 null 表示“从本月起取消”）。
 * 返回 {update: {id, patch}} / {insert: row} / {noop: true}。只会动 effective_from = currentMonth 的行。
 */
function planBudgetChange(rows, scope, amountCents, currentMonth, now, newId) {
  var same = null;
  (rows || []).forEach(function (r) { if (r.scope === scope && r.effective_from === currentMonth) same = r; });
  var ts = now.toISOString();
  if (same) {
    if ((same.amount_cents === undefined ? null : same.amount_cents) === amountCents) return { noop: true };
    return { update: { id: same.id, patch: { amount_cents: amountCents, updated_at: ts } } };
  }
  // 本来就没有预算时“取消”不需要写任何东西
  if (amountCents === null && effectiveBudget(rows, scope, currentMonth) === null) return { noop: true };
  return { insert: { id: newId(), scope: scope, amount_cents: amountCents, effective_from: currentMonth, updated_at: ts } };
}

/** 预算范围校验：只能是总预算或未归档的支出类别；“未分类”不能单独设预算（spec 7A.1）。返回类别（总预算返回 null）。 */
function validateBudgetScope(categories, scope) {
  if (scope === BUDGET_TOTAL) return null;
  var cat = null;
  (categories || []).forEach(function (c) { if (c.id === scope) cat = c; });
  if (!cat) throw UserError('找不到这个类别');
  if (cat.system_key === UNCATEGORIZED_KEY) throw UserError('“未分类”不能单独设预算，它的支出计入总预算');
  if (cat.type !== 'expense') throw UserError('只能给支出类别设预算');
  if (cat.archived) throw UserError('这个类别已删除，不能设预算');
  return cat;
}

/** 预算金额输入：空 = 取消（返回 null）；否则必须是大于 0 的美元金额。 */
function parseBudgetAmount(amount) {
  var text = amount === null || amount === undefined ? '' : String(amount).trim();
  if (text === '') return null;
  if (/^[-−]/.test(text)) throw UserError('预算金额必须大于 0');
  var cents = parseUsdToCents(text);
  if (cents === null) throw UserError('金额格式不正确，例如 500 或 500.00');
  if (!(cents > 0)) throw UserError('预算金额必须大于 0');
  return cents;
}

/**
 * 已用（spec 7A.2）：该月未删除的支出中、该范围内已知金额之和（退款为负数，自然冲减）。
 * 总预算包括所有支出类别（含“未分类”）。待补全不算 0，单独计数。
 */
function budgetUsage(entries, scope, month) {
  var used = 0, pending = 0;
  (entries || []).forEach(function (e) {
    if (!isLive(e) || e.type !== 'expense' || e.month_ny !== month) return;
    if (scope !== BUDGET_TOTAL && e.category_id !== scope) return;
    if (e.amount_cents === null || e.amount_cents === undefined) pending++;
    else used += e.amount_cents;
  });
  return { used_cents: used, pending_count: pending };
}

/** 已用比例（整数百分比，四舍五入，0.5 进位）；已用 ≤ 0 时为 0。 */
function budgetUsedPct(used, budget) {
  if (!(budget > 0) || used <= 0) return 0;
  return Math.floor((2 * used * 100 + budget) / (2 * budget));
}

/** 状态：over（已用 > 预算）/ near（已用×100 ≥ 比例×预算）/ ok。 */
function budgetState(used, budget, nearPct) {
  if (used > budget) return 'over';
  if (used * 100 >= nearPct * budget) return 'near';
  return 'ok';
}

function budgetItem_(scope, name, budget, usage, nearPct) {
  var usedPct = budgetUsedPct(usage.used_cents, budget);
  return {
    scope: scope,
    name: name,
    budget_cents: budget,
    used_cents: usage.used_cents,
    remaining_cents: budget - usage.used_cents,      // 为负 = 超出
    used_pct: usedPct,
    remaining_pct: Math.max(0, 100 - usedPct),
    state: budgetState(usage.used_cents, budget, nearPct),
    pending_count: usage.pending_count
  };
}

/**
 * 某月的预算总览：总预算 + 各类别预算（只列该月有效的），以及待补全笔数和 D10 提示。
 * categories 用来取类别名称和排序（已归档的类别在过去月份仍按当时的预算显示）。
 */
function computeBudgetView(entries, categories, rows, month, nearPct) {
  var catById = {};
  (categories || []).forEach(function (c) { catById[c.id] = c; });
  var totalBudget = effectiveBudget(rows, BUDGET_TOTAL, month);
  var totalUsage = budgetUsage(entries, BUDGET_TOTAL, month);
  var view = {
    month: month,
    near_pct: nearPct,
    total: totalBudget === null ? null : budgetItem_(BUDGET_TOTAL, '总预算', totalBudget, totalUsage, nearPct),
    total_used_cents: totalUsage.used_cents,
    pending_count: totalUsage.pending_count,
    categories: [],
    category_sum_cents: 0,
    warning: null
  };
  var seen = {};
  (rows || []).forEach(function (r) {
    if (r.scope === BUDGET_TOTAL || seen[r.scope]) return;
    seen[r.scope] = true;
    var cat = catById[r.scope];
    if (cat && cat.system_key === UNCATEGORIZED_KEY) return;   // 防御：表格里被手动写入的“未分类”预算不显示
    var b = effectiveBudget(rows, r.scope, month);
    if (b === null) return;
    var item = budgetItem_(r.scope, cat ? cat.name : '未知类别', b, budgetUsage(entries, r.scope, month), nearPct);
    item.sort = cat ? Number(cat.sort) || 0 : 0;
    item.archived = !!(cat && cat.archived);
    view.categories.push(item);
    view.category_sum_cents += b;
  });
  view.categories.sort(function (a, b) { return a.sort - b.sort || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  // D10：类别预算之和高于总预算时提示，但不阻止保存
  if (view.total && view.category_sum_cents > view.total.budget_cents) {
    view.warning = '类别预算合计 $' + formatCents(view.category_sum_cents) + '，高于总预算 $' + formatCents(view.total.budget_cents);
  }
  view.has_any = !!view.total || view.categories.length > 0;
  return view;
}

/** 月报“本月预算小结”的一句话（小助手上线前的白话版，PRD 6A.5）。没有任何预算返回 ''。 */
function budgetSummarySentence(view) {
  if (!view || !view.has_any) return '';
  var parts = [];
  function amt(c) { return '$' + formatCents(Math.abs(c)); }
  if (view.total) parts.push('总预算' + (view.total.state === 'over' ? '超出 ' : '剩余 ') + amt(view.total.remaining_cents));
  var over = view.categories.filter(function (c) { return c.state === 'over'; });
  var near = view.categories.filter(function (c) { return c.state === 'near'; });
  over.forEach(function (c) { parts.push(c.name + '超出 ' + amt(c.remaining_cents)); });
  near.forEach(function (c) { parts.push(c.name + '已用 ' + c.used_pct + '%'); });
  if (!over.length && !near.length && view.categories.length) parts.push('各类别预算都在范围内');
  return parts.join('，') + '。';
}

/** 从 settings 表读出“接近预算”比例；没有、格式不对或超出 50–100 时用默认 80。 */
function readNearPct(settingsRows) {
  var v = null;
  (settingsRows || []).forEach(function (r) { if (r.key === BUDGET_NEAR_PCT_KEY) v = r.value; });
  var n = parseNearPct_(v);
  return n === null ? BUDGET_NEAR_PCT_DEFAULT : n;
}

function parseNearPct_(v) {
  var s = v === null || v === undefined ? '' : String(v).trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  var n = Number(s);
  return n >= BUDGET_NEAR_PCT_MIN && n <= BUDGET_NEAR_PCT_MAX ? n : null;
}

/** “预算提醒比例”输入校验：50–100 的整数。 */
function validateNearPct(v) {
  var n = parseNearPct_(v);
  if (n === null) throw UserError('提醒比例应为 ' + BUDGET_NEAR_PCT_MIN + '–' + BUDGET_NEAR_PCT_MAX + ' 之间的整数');
  return n;
}

/** 'YYYY-MM' 这个月有几天。 */
function daysInMonth(month) {
  var y = +month.slice(0, 4), mo = +month.slice(5, 7);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
