/**
 * 储蓄目标和月末估算（纯函数）。金额均为整数美分，日期均按费城时间。
 * 存入记录只影响目标进度，绝不参与 entries 的收入、消费、预算或报表计算。
 */

function savingsAmount_(value, label, allowZero) {
  var cents = parseUsdToCents(value);
  if (cents === null || (allowZero ? cents < 0 : cents <= 0)) {
    throw UserError(label + (allowZero ? '请填写 0 或正数，例如 0 或 12.34' : '请填写大于 0 的金额，例如 12.34'));
  }
  return cents;
}

function savingsDate_(value, label) {
  var s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw UserError(label + '格式不正确');
  try {
    parseLocalNY(s + 'T12:00');
  } catch (e) {
    throw UserError(label + '不存在，请重新选择');
  }
  return s;
}

function savingsMonthsInclusive_(current, target) {
  return (+target.slice(0, 4) - +current.slice(0, 4)) * 12 + (+target.slice(5, 7) - +current.slice(5, 7)) + 1;
}

function savingsContributionTotal_(goalId, contributions) {
  return (contributions || []).reduce(function (total, c) {
    return c.goal_id === goalId ? total + c.amount_cents : total;
  }, 0);
}

/**
 * 完整表单：{name, target_amount, starting_saved_amount, monthly_amount, target_date?}。
 * 月存款留空时，有未来目标日期则采用当前建议值；无日期且未完成时必须填写正数。
 * 已过期目标仍可修改其他信息；只有新设/更改的日期必须在今天之后。
 */
function validateSavingsGoalInput(input, existing, contributions, now) {
  input = input || {};
  var name = String(input.name || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw UserError('目标名称请填写 1–60 个字');
  var target = savingsAmount_(input.target_amount, '目标金额', false);
  var starting = savingsAmount_(input.starting_saved_amount, '已经存下的金额', true);
  var deposited = savingsContributionTotal_(existing ? existing.id : null, contributions);
  var remaining = Math.max(0, target - starting - deposited);
  var today = dateNY(now);
  var date = String(input.target_date || '').trim() || null;
  if (date) {
    date = savingsDate_(date, '目标日期');
    if (date <= today && (!existing || date !== existing.target_date)) {
      throw UserError('目标日期请选择今天之后的日期');
    }
  }
  var blankMonthly = input.monthly_amount === null || input.monthly_amount === undefined || String(input.monthly_amount).trim() === '';
  var monthly;
  if (blankMonthly) {
    if (remaining === 0) monthly = 0;
    else if (date && date >= today) monthly = Math.ceil(remaining / savingsMonthsInclusive_(monthNY(now), date.slice(0, 7)));
    else throw UserError('请填写每月计划存入的金额');
  } else {
    monthly = savingsAmount_(input.monthly_amount, '每月计划存款', true);
    if (remaining > 0 && !date && monthly === 0) throw UserError('没有目标日期时，每月计划存款需要大于 0');
  }
  return { name: name, target_cents: target, starting_saved_cents: starting, monthly_cents: monthly, target_date: date };
}

/** 前端必须为一次存入生成固定 request_id；重试同一请求不能重复计入进度。 */
function validateSavingsContributionInput(input, now) {
  input = input || {};
  var requestId = String(input.request_id || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw UserError('这次存入的编号无效，请关闭后重新打开存入窗口');
  var date = savingsDate_(input.date_ny || dateNY(now), '存入日期');
  if (date > dateNY(now)) throw UserError('存入日期不能在未来');
  return { id: requestId, goal_id: String(input.goal_id || ''), amount_cents: savingsAmount_(input.amount, '存入金额', false), date_ny: date };
}

/** 完成的目标保留原计划，但不再占用今后的月度储蓄安排。 */
function computeSavingsGoalView(goal, contributions, now) {
  var deposits = (contributions || []).filter(function (c) { return c.goal_id === goal.id; });
  var deposited = savingsContributionTotal_(goal.id, deposits);
  var saved = goal.starting_saved_cents + deposited;
  var remaining = Math.max(0, goal.target_cents - saved);
  var complete = remaining === 0;
  var today = dateNY(now);
  var overdue = !complete && !!goal.target_date && goal.target_date < today;
  var monthsLeft = goal.target_date && !overdue ? Math.max(1, savingsMonthsInclusive_(monthNY(now), goal.target_date.slice(0, 7))) : null;
  var required = complete ? 0 : monthsLeft === null ? null : Math.ceil(remaining / monthsLeft);
  var duration = complete ? 0 : goal.monthly_cents > 0 ? Math.ceil(remaining / goal.monthly_cents) : null;
  return {
    id: goal.id, name: goal.name, target_cents: goal.target_cents, starting_saved_cents: goal.starting_saved_cents,
    deposited_cents: deposited, saved_cents: saved, remaining_cents: remaining,
    progress_tenths: Math.min(1000, percentTenths(saved, goal.target_cents) || 0),
    monthly_cents: goal.monthly_cents, effective_monthly_cents: complete ? 0 : goal.monthly_cents,
    target_date: goal.target_date || null, completed: complete, overdue: overdue,
    months_to_deadline: monthsLeft, required_monthly_cents: required,
    estimated_months: duration,
    estimated_completion_month: duration === null ? null : addMonths(monthNY(now), Math.max(0, duration - 1)),
    monthly_plan_meets_deadline: goal.target_date ? (complete || (!overdue && goal.monthly_cents >= required)) : null,
    contributions: deposits.slice().sort(function (a, b) {
      return a.date_ny > b.date_ny ? -1 : a.date_ny < b.date_ny ? 1 : a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0;
    }).map(function (c) { return { id: c.id, amount_cents: c.amount_cents, date_ny: c.date_ny }; })
  };
}

/** 最近三个完整自然月；每一侧仅以有已知金额的月份作分母，未知金额另行计数。 */
function savingsHistory_(entries, type, months) {
  var rows = months.map(function (month) {
    var known = 0, pending = 0, total = 0;
    entries.forEach(function (e) {
      if (e.type !== type || e.month_ny !== month) return;
      if (e.amount_cents === null || e.amount_cents === undefined) pending++;
      else { known++; total += e.amount_cents; }
    });
    return { month: month, total_cents: total, known_count: known, pending_count: pending };
  });
  var usable = rows.filter(function (r) { return r.known_count > 0; });
  return {
    months: rows,
    months_used: usable.map(function (r) { return r.month; }),
    month_count: usable.length,
    average_cents: usable.length ? Math.round(usable.reduce(function (sum, r) { return sum + r.total_cents; }, 0) / usable.length) : null,
    pending_count: rows.reduce(function (sum, r) { return sum + r.pending_count; }, 0)
  };
}

/**
 * 共享预测入口，供储蓄页和小助手复用。estimate 是当前月份的手动估算行。
 * null 表示尚不能估算；0 表示已估算为零，不可互相替代。
 */
function computeSavingsForecast(entries, goals, contributions, estimate, now) {
  var month = monthNY(now), today = dateNY(now);
  var historyMonths = [addMonths(month, -3), addMonths(month, -2), addMonths(month, -1)];
  var live = (entries || []).filter(function (e) { return isLive(e); });
  var incomeHistory = savingsHistory_(live, 'income', historyMonths);
  var expenseHistory = savingsHistory_(live, 'expense', historyMonths);
  var currentIncome = 0, currentExpense = 0, pendingIncome = 0, pendingExpense = 0;
  live.forEach(function (e) {
    if (e.month_ny !== month || (e.date_ny && e.date_ny > today)) return;
    var missing = e.amount_cents === null || e.amount_cents === undefined;
    if (e.type === 'income') { if (missing) pendingIncome++; else currentIncome += e.amount_cents; }
    if (e.type === 'expense') { if (missing) pendingExpense++; else currentExpense += e.amount_cents; }
  });
  estimate = estimate && estimate.month === month ? estimate : {};
  var manualIncome = estimate.income_cents === null || estimate.income_cents === undefined ? null : estimate.income_cents;
  var manualExpense = estimate.expense_cents === null || estimate.expense_cents === undefined ? null : estimate.expense_cents;
  var income = manualIncome !== null ? manualIncome : incomeHistory.average_cents;
  var expenseBase = expenseHistory.average_cents !== null ? expenseHistory.average_cents : manualExpense;
  var expense = expenseBase === null ? null : Math.max(expenseBase, currentExpense);
  var goalViews = (goals || []).map(function (g) { return computeSavingsGoalView(g, contributions, now); });
  var planned = goalViews.reduce(function (sum, g) { return sum + g.effective_monthly_cents; }, 0);
  var available = income !== null && expense !== null;
  var net = available ? income - expense : null;
  var capacity = available ? Math.max(0, net) : null;
  var pending = incomeHistory.pending_count + expenseHistory.pending_count + pendingIncome + pendingExpense;
  return {
    month: month, as_of_date: today, is_estimate: true,
    income: { projected_cents: income, source: manualIncome !== null ? 'manual' : income === null ? 'missing' : 'history',
      manual_cents: manualIncome, actual_to_date_cents: currentIncome, history: incomeHistory, current_pending_count: pendingIncome },
    expense: { projected_cents: expense, source: expenseHistory.average_cents !== null ? 'history' : manualExpense !== null ? 'manual' : 'missing',
      manual_cents: manualExpense, baseline_cents: expenseBase, actual_to_date_cents: currentExpense, history: expenseHistory, current_pending_count: pendingExpense },
    needs_income_estimate: income === null, needs_expense_estimate: expense === null,
    can_estimate: available, incomplete: pending > 0, pending_count: pending,
    monthly_net_cents: net, monthly_savings_capacity_cents: capacity,
    planned_savings_cents: planned,
    month_end_available_cents: available ? Math.max(0, net - planned) : null,
    over_capacity: available ? planned > capacity : null,
    over_capacity_cents: available ? Math.max(0, planned - capacity) : null,
    active_goal_count: goalViews.filter(function (g) { return !g.completed; }).length
  };
}
