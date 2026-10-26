/** Build an accounting-style date-range report from live ledger rows without writing anything. */
function svcGenerateTransactionReport(repo, startDate, endDate, lang) {
  var en = lang === 'en';
  startDate = String(startDate || '').trim();
  endDate = String(endDate || '').trim();
  if (!transactionReportDateValid_(startDate) || !transactionReportDateValid_(endDate)) throw UserError('日期格式不正确，请使用 YYYY-MM-DD');
  if (startDate > endDate) throw UserError('开始日期不能晚于结束日期');

  var entries = repo.list('entries').filter(isLive);
  var categories = repo.list('categories');
  var catById = indexById_(categories);
  var opening = 0, openingPendingCount = 0;
  entries.forEach(function (e) {
    if (!e.date_ny || e.date_ny >= startDate) return;
    if (e.amount_cents === null || e.amount_cents === undefined) { openingPendingCount++; return; }
    opening += e.type === 'income' ? e.amount_cents : (e.type === 'expense' ? -e.amount_cents : 0);
  });

  var selected = entries.filter(function (e) { return e.date_ny >= startDate && e.date_ny <= endDate; });
  selected.sort(function (a, b) {
    var byDate = String(a.date_ny || '').localeCompare(String(b.date_ny || ''));
    if (byDate) return byDate;
    var byTime = String(a.occurred_at || '').localeCompare(String(b.occurred_at || ''));
    return byTime || String(a.id || '').localeCompare(String(b.id || ''));
  });

  var balance = opening, balanceComplete = openingPendingCount === 0, pendingCount = 0, byMonth = {}, months = [];
  selected.forEach(function (e) {
    var month = String(e.date_ny).slice(0, 7);
    if (!byMonth[month]) { byMonth[month] = []; months.push(month); }
    var income = null, expense = null;
    if (e.amount_cents !== null && e.amount_cents !== undefined) {
      if (e.type === 'income') { income = e.amount_cents; balance += e.amount_cents; }
      else if (e.type === 'expense') { expense = e.amount_cents; balance -= e.amount_cents; }
    } else { pendingCount++; balanceComplete = false; }
    var cat = catById[e.category_id];
    var displayCategory = e.channel === 'apple_pay' ? 'Apple Pay'
      : (e.channel === 'gmail_receipt' ? 'Online Order'
        : (cat ? ((en && defaultCategoryNameEn(cat.id)) || cat.name) : (en ? 'Unknown category' : '未知类别')));
    byMonth[month].push({ date: e.date_ny, description: e.merchant || e.note || '', category: displayCategory,
      income_cents: income, expense_cents: expense, balance_cents: balance,
      status: en
        ? [e.amount_cents === null || e.amount_cents === undefined ? 'Amount missing' : '', balanceComplete ? '' : 'Balance incomplete'].filter(Boolean).join('; ')
        : (e.amount_cents === null || e.amount_cents === undefined ? '金额待补全；' : '') + (balanceComplete ? '' : '余额不完整') });
  });

  var budgetRows = listOptional_(repo, 'budgets'), nearPct = readNearPct(listOptional_(repo, 'settings'));
  return { start_date: startDate, end_date: endDate, opening_balance_cents: opening,
    opening_pending_count: openingPendingCount, pending_count: pendingCount,
    months: months.map(function (month) {
      var view = computeBudgetView(entries, categories, budgetRows, month, nearPct);
      var budget = null;
      if (view.has_any) budget = {
        total: view.total ? { budget_cents: view.total.budget_cents, actual_cents: view.total.used_cents, remaining_cents: view.total.remaining_cents } : null,
        categories: view.categories.map(function (c) { return { scope: c.scope, name: c.name, budget_cents: c.budget_cents, actual_cents: c.used_cents, remaining_cents: c.remaining_cents }; })
      };
      return { month: month, rows: byMonth[month], budget: budget };
    }) };
}

function transactionReportDateValid_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try { parseLocalNY(date + 'T12:00'); return true; } catch (e) { return false; }
}
