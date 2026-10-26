/** 储蓄 repo 操作；所有写操作由 web.js 的脚本锁保护。 */
function savingsReady_(repo) {
  return tableReady_(repo, 'savings_goals') && tableReady_(repo, 'savings_contributions') && tableReady_(repo, 'savings_estimates');
}

function requireSavings_(repo) {
  if (!savingsReady_(repo)) {
    throw UserError('储蓄功能还没有启用：请先在脚本编辑器里重新运行一次 setupLedger，再回来设置');
  }
}

/** 可单独供助手复用；旧账本缺少储蓄表时使用空目标/空估算，读取不建表。 */
function svcSavingsForecast_(repo, now) {
  var month = monthNY(now);
  var estimate = listOptional_(repo, 'savings_estimates').filter(function (r) { return r.month === month; })[0];
  return computeSavingsForecast(repo.list('entries'), listOptional_(repo, 'savings_goals'),
    listOptional_(repo, 'savings_contributions'), estimate, now);
}

/** 所有写接口也返回此视图，使界面直接以服务器保存后的结果更新。 */
function svcGetSavings(repo, now) {
  var month = monthNY(now);
  var goals = listOptional_(repo, 'savings_goals');
  var contributions = listOptional_(repo, 'savings_contributions');
  var estimate = listOptional_(repo, 'savings_estimates').filter(function (r) { return r.month === month; })[0] || null;
  return {
    ready: savingsReady_(repo), current_month: month, today_ny: dateNY(now),
    goals: goals.map(function (g) { return computeSavingsGoalView(g, contributions, now); }),
    estimates: { month: month, income_cents: estimate ? estimate.income_cents : null, expense_cents: estimate ? estimate.expense_cents : null },
    forecast: computeSavingsForecast(repo.list('entries'), goals, contributions, estimate, now)
  };
}

function svcSaveSavingsGoal(repo, input, now, newId) {
  requireSavings_(repo);
  input = input || {};
  var goals = repo.list('savings_goals');
  var existing = input.id ? findById_(goals, String(input.id)) : null;
  if (input.id && !existing) throw UserError('找不到这个储蓄目标，请刷新后再试');
  var fields = validateSavingsGoalInput(input, existing, repo.list('savings_contributions'), now);
  fields.updated_at = now.toISOString();
  if (existing) repo.update('savings_goals', existing.id, fields);
  else {
    fields.id = newId();
    fields.created_at = fields.updated_at;
    repo.insert('savings_goals', fields);
  }
  return svcGetSavings(repo, now);
}

function svcRecordSavingsContribution(repo, input, now) {
  requireSavings_(repo);
  input = input || {};
  var previous = findById_(repo.list('savings_contributions'), String(input.request_id || ''));
  var validationInput = Object.assign({}, input);
  // 省略日期的同一请求跨午夜重试时，沿用首次保存的日期，不能重新默认成“今天”。
  if (previous && !validationInput.date_ny) validationInput.date_ny = previous.date_ny;
  var row = validateSavingsContributionInput(validationInput, now);
  if (!findById_(repo.list('savings_goals'), row.goal_id)) throw UserError('找不到这个储蓄目标，请刷新后再试');
  if (previous) {
    if (previous.goal_id !== row.goal_id || previous.amount_cents !== row.amount_cents || previous.date_ny !== row.date_ny) {
      throw UserError('这次存入已记录，请重新打开窗口记录另一笔');
    }
    return svcGetSavings(repo, now);
  }
  row.created_at = now.toISOString();
  repo.insert('savings_contributions', row);
  return svcGetSavings(repo, now);
}

/**
 * {month, income_amount, expense_amount}。month 必须是当前月，防止页面跨月后把旧估算写入新月。
 * 每个金额字段：省略则保留原值；空文字/null 则清除；0 则按零估算。
 */
function svcSaveSavingsEstimates(repo, input, now) {
  requireSavings_(repo);
  input = input || {};
  var month = monthNY(now);
  if (input.month !== month) throw UserError('月份已经变化，请刷新后再填写本月估算');
  var existing = repo.list('savings_estimates').filter(function (r) { return r.month === month; })[0];
  var fields = { income_cents: existing ? existing.income_cents : null, expense_cents: existing ? existing.expense_cents : null,
    updated_at: now.toISOString() };
  [['income_amount', 'income_cents', '预计月收入'], ['expense_amount', 'expense_cents', '预计月支出']].forEach(function (f) {
    if (!Object.prototype.hasOwnProperty.call(input, f[0])) return;
    var value = input[f[0]];
    fields[f[1]] = value === null || value === undefined || String(value).trim() === '' ? null : savingsAmount_(value, f[2], true);
  });
  if (existing) repo.update('savings_estimates', month, fields);
  else { fields.month = month; repo.insert('savings_estimates', fields); }
  return svcGetSavings(repo, now);
}
