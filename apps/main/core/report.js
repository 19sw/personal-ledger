/**
 * 月报计算（PRD 第 5 节、spec 第 7 节）。纯函数：输入账目、类别、来源，输出报表数字。
 * 规则：
 * - 只统计该月（费城时间）未删除的账目；
 * - 待补全（金额为空）不计入任何金额，也不计入百分比分母，只计数；
 * - 退款是负数，自然从所属类别和支出总额中扣除；
 * - 百分比 = 类别金额 / 总额，四舍五入保留一位小数（整数运算）。
 */

var UNSPECIFIED_SOURCE_NAME = '未指定来源';

function computeReport(entries, categories, sources, month) {
  var catById = indexById_(categories);
  var srcById = indexById_(sources);
  var monthEntries = entries.filter(function (e) { return isLive(e) && e.month_ny === month; });

  var pendingCount = 0;
  var known = [];
  monthEntries.forEach(function (e) {
    if (e.amount_cents === null || e.amount_cents === undefined) pendingCount++;
    else known.push(e);
  });

  var expenses = known.filter(function (e) { return e.type === 'expense'; });
  var incomes = known.filter(function (e) { return e.type === 'income'; });

  var expenseTotal = sumCents_(expenses);
  var incomeTotal = sumCents_(incomes);

  var expenseRows = groupRows_(expenses, 'category_id', function (id) {
    return catById[id] ? catById[id].name : '未知类别';
  }, expenseTotal);

  var incomeRows = groupRows_(incomes, 'category_id', function (id) {
    return catById[id] ? catById[id].name : '未知类别';
  }, incomeTotal);
  // 收入类别下再按具体来源细分；来源占比的分母是“总收入”（PRD 5.2）
  incomeRows.forEach(function (row) {
    var inCat = incomes.filter(function (e) { return e.category_id === row.id; });
    row.sources = groupRows_(inCat, 'income_source_id', function (id) {
      return id && srcById[id] ? srcById[id].name : UNSPECIFIED_SOURCE_NAME;
    }, incomeTotal);
  });

  var scale = Math.max(incomeTotal, expenseTotal, 0);
  return {
    month: month,
    pending_count: pendingCount,
    expense: { total_cents: expenseTotal, rows: expenseRows, show_percent: expenseTotal > 0 },
    income: { total_cents: incomeTotal, rows: incomeRows, show_percent: incomeTotal > 0 },
    comparison: {
      income_cents: incomeTotal,
      expense_cents: expenseTotal,
      diff_cents: incomeTotal - expenseTotal,
      // 柱子长度（0–1000，即 0.0%–100.0%），两根柱子用同一刻度：较大者为满格
      income_bar_tenths: scale > 0 ? percentTenths(Math.max(incomeTotal, 0), scale) : 0,
      expense_bar_tenths: scale > 0 ? percentTenths(Math.max(expenseTotal, 0), scale) : 0
    }
  };
}

function sumCents_(list) {
  return list.reduce(function (acc, e) { return acc + e.amount_cents; }, 0);
}

function indexById_(list) {
  var out = {};
  (list || []).forEach(function (x) { out[x.id] = x; });
  return out;
}

/**
 * 按某个字段分组求和。排序：金额从大到小；净额为负（净退款）的组排在最后，并标 net_refund。
 * 空值（例如没有填写来源）归为同一组，id 为 ''。
 */
function groupRows_(list, field, nameOf, total) {
  var groups = Object.create(null);
  var order = [];
  list.forEach(function (e) {
    var key = e[field] || '';
    if (!(key in groups)) { groups[key] = 0; order.push(key); }
    groups[key] += e.amount_cents;
  });
  var rows = order.map(function (key) {
    var cents = groups[key];
    return {
      id: key,
      name: nameOf(key),
      cents: cents,
      percent_tenths: cents >= 0 ? percentTenths(cents, total) : null,
      net_refund: cents < 0
    };
  });
  rows.sort(function (a, b) {
    if (a.net_refund !== b.net_refund) return a.net_refund ? 1 : -1;
    if (b.cents !== a.cents) return b.cents - a.cents;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

/** 月报页默认显示的月份：当前费城月份的上一个月（PRD 第 5 节）。 */
function defaultReportMonth(now) {
  return addMonths(monthNY(now), -1);
}

/**
 * 月账单：某一自然年（费城时间 1.1–12.31）每个月的收入、支出、结余。
 * 每个月都直接调用 computeReport，所以口径与月报完全一致（退款抵扣、待补全不计金额只计数、删除的不算）。
 * 只列到当前月份为止（今年只到本月；以后的年份没有月份），从该年第一个有账目的月份开始，新的月份在前。
 */
function computeMonthBills(entries, categories, sources, year, currentMonth) {
  var y = String(year);
  var curYear = currentMonth.slice(0, 4);
  var last = y < curYear ? 12 : y === curYear ? +currentMonth.slice(5, 7) : 0;
  var inYear = (entries || []).filter(function (e) { return e.month_ny && e.month_ny.slice(0, 4) === y; });
  var out = { year: y, months: [], income_cents: 0, expense_cents: 0, diff_cents: 0, pending_count: 0 };
  // 从这一年第一个有账目的月份开始列（之前的空月份不列）
  var first = 13;
  inYear.forEach(function (e) { if (isLive(e)) { var em = +e.month_ny.slice(5, 7); if (em < first) first = em; } });
  for (var m = last; m >= first; m--) {
    var month = y + '-' + pad2_(m);
    var rep = computeReport(inYear, categories, sources, month);
    var row = {
      month: month,
      income_cents: rep.income.total_cents,
      expense_cents: rep.expense.total_cents,
      diff_cents: rep.comparison.diff_cents,
      pending_count: rep.pending_count
    };
    out.months.push(row);
    out.income_cents += row.income_cents;
    out.expense_cents += row.expense_cents;
    out.diff_cents += row.diff_cents;
    out.pending_count += row.pending_count;
  }
  return out;
}

/** 有账目（未删除、月份不晚于当前月）的年份，新的在前。 */
function billYears(entries, currentMonth) {
  var seen = {}, years = [];
  (entries || []).forEach(function (e) {
    if (!isLive(e) || !e.month_ny || e.month_ny > currentMonth) return;
    var y = e.month_ny.slice(0, 4);
    if (!seen[y]) { seen[y] = true; years.push(y); }
  });
  return years.sort().reverse();
}

/** 年账单：每个有账目的年份一行（数字由该年的月账单相加），以及所有年份的合计。 */
function computeYearBills(entries, categories, sources, currentMonth) {
  var out = { years: [], income_cents: 0, expense_cents: 0, diff_cents: 0, pending_count: 0 };
  billYears(entries, currentMonth).forEach(function (y) {
    var b = computeMonthBills(entries, categories, sources, y, currentMonth);
    out.years.push({ year: y, income_cents: b.income_cents, expense_cents: b.expense_cents, diff_cents: b.diff_cents, pending_count: b.pending_count });
    out.income_cents += b.income_cents;
    out.expense_cents += b.expense_cents;
    out.diff_cents += b.diff_cents;
    out.pending_count += b.pending_count;
  });
  return out;
}
