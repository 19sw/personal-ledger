'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, memoryRepo, plain } = require('./helpers/gas');

test('date-range report uses lifetime opening balance, inclusive rows, month groups and continuous balances', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  repo.insert('categories', { id: 'food', type: 'expense', name: '餐饮', sort: 1, archived: false });
  repo.insert('categories', { id: 'salary', type: 'income', name: '工资', sort: 2, archived: false });
  [
    { id: 'old-income', type: 'income', amount_cents: 10000, date_ny: '2025-12-31', month_ny: '2025-12', category_id: 'salary', merchant: '工资' },
    { id: 'old-expense', type: 'expense', amount_cents: 2500, date_ny: '2026-01-01', month_ny: '2026-01', category_id: 'food', merchant: '午餐' },
    { id: 'in-range', type: 'expense', amount_cents: 500, date_ny: '2026-01-31', month_ny: '2026-01', category_id: 'food', merchant: '咖啡' },
    { id: 'next-month', type: 'income', amount_cents: 3000, date_ny: '2026-02-01', month_ny: '2026-02', category_id: 'salary', merchant: '兼职' },
    { id: 'deleted', type: 'income', amount_cents: 9999, date_ny: '2025-12-01', month_ny: '2025-12', category_id: 'salary', deleted_at: '2025-12-02' }
  ].forEach((e) => repo.insert('entries', e));
  const report = plain(g.svcGenerateTransactionReport(repo, '2026-01-31', '2026-02-01'));
  assert.equal(report.opening_balance_cents, 7500);
  assert.deepEqual(report.months.map((m) => m.month), ['2026-01', '2026-02']);
  assert.equal(report.months[0].rows[0].balance_cents, 7000);
  assert.equal(report.months[0].rows[0].expense_cents, 500);
  assert.equal(report.months[1].rows[0].balance_cents, 10000);
  assert.equal(report.months[1].rows[0].income_cents, 3000);
  assert.equal(report.months[0].rows.length, 1);
});

test('date-range report budget comparisons use full-month actuals, not range-only actuals', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  repo.insert('categories', { id: 'food', type: 'expense', name: '餐饮', sort: 1, archived: false });
  repo.insert('budgets', { id: 'total', scope: 'total', amount_cents: 10000, effective_from: '2026-01' });
  repo.insert('budgets', { id: 'food-budget', scope: 'food', amount_cents: 6000, effective_from: '2026-01' });
  [
    { id: 'in-range', type: 'expense', amount_cents: 1000, date_ny: '2026-01-15', month_ny: '2026-01', category_id: 'food' },
    { id: 'same-month-outside-range', type: 'expense', amount_cents: 2500, date_ny: '2026-01-25', month_ny: '2026-01', category_id: 'food' }
  ].forEach((e) => repo.insert('entries', e));
  const report = plain(g.svcGenerateTransactionReport(repo, '2026-01-15', '2026-01-15'));
  assert.equal(report.months[0].rows.length, 1);
  assert.equal(report.months[0].budget.total.actual_cents, 3500);
  assert.equal(report.months[0].budget.total.remaining_cents, 6500);
  assert.equal(report.months[0].budget.categories[0].actual_cents, 3500);
});

test('date-range report rejects malformed dates and reversed ranges', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  assert.throws(() => g.svcGenerateTransactionReport(repo, '2026-02-30', '2026-03-01'), /日期/);
  assert.throws(() => g.svcGenerateTransactionReport(repo, '2026-03-02', '2026-03-01'), /开始日期/);
});

test('date-range report marks missing amounts and warns when opening or running balances are incomplete', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  repo.insert('categories', { id: 'food', type: 'expense', name: '餐饮', sort: 1, archived: false });
  repo.insert('categories', { id: 'salary', type: 'income', name: '工资', sort: 2, archived: false });
  [
    { id: 'before-pending', type: 'expense', amount_cents: null, date_ny: '2026-01-05', month_ny: '2026-01', category_id: 'food' },
    { id: 'before-known', type: 'expense', amount_cents: 2000, date_ny: '2026-01-08', month_ny: '2026-01', category_id: 'food' },
    { id: 'selected-pending', type: 'expense', amount_cents: null, date_ny: '2026-01-10', month_ny: '2026-01', category_id: 'food' },
    { id: 'selected-income', type: 'income', amount_cents: 5000, date_ny: '2026-01-11', month_ny: '2026-01', category_id: 'salary' }
  ].forEach((e) => repo.insert('entries', e));
  const report = plain(g.svcGenerateTransactionReport(repo, '2026-01-10', '2026-01-11'));
  assert.equal(report.opening_balance_cents, -2000);
  assert.equal(report.opening_pending_count, 1);
  assert.equal(report.pending_count, 1);
  assert.equal(report.months[0].rows[0].status, '金额待补全；余额不完整');
  assert.equal(report.months[0].rows[1].status, '余额不完整');
  assert.equal(report.months[0].rows[1].balance_cents, 3000);
});

test('date-range report labels automatic sources for display without allowing missing categories to break balances', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  repo.insert('categories', { id: 'uncat', type: 'expense', name: '未分类', system_key: 'uncategorized', sort: 1, archived: false });
  repo.insert('categories', { id: 'food', type: 'expense', name: '餐饮', sort: 2, archived: false });
  [
    { id: 'apple', type: 'expense', amount_cents: 724, date_ny: '2026-01-01', month_ny: '2026-01', category_id: 'uncat', channel: 'apple_pay', merchant: '茶饮店' },
    { id: 'online', type: 'expense', amount_cents: 500, date_ny: '2026-01-02', month_ny: '2026-01', category_id: 'uncat', channel: 'gmail_receipt', merchant: '网店' },
    { id: 'missing-category', type: 'expense', amount_cents: 100, date_ny: '2026-01-03', month_ny: '2026-01', category_id: null, channel: 'manual', merchant: '无分类' },
    { id: 'manual', type: 'expense', amount_cents: 200, date_ny: '2026-01-04', month_ny: '2026-01', category_id: 'food', channel: 'manual', merchant: '午餐' },
    { id: 'missing-amount', type: 'expense', amount_cents: null, date_ny: '2026-01-05', month_ny: '2026-01', category_id: 'uncat', channel: 'apple_pay', merchant: '金额待补' }
  ].forEach((e) => repo.insert('entries', e));

  const rows = plain(g.svcGenerateTransactionReport(repo, '2026-01-01', '2026-01-05')).months[0].rows;
  assert.deepEqual(rows.map((row) => row.category), ['Apple Pay', 'Online Order', '未知类别', '餐饮', 'Apple Pay']);
  assert.equal(rows[0].balance_cents, -724);
  assert.equal(rows[0].status, '');
  assert.equal(rows[2].balance_cents, -1324);
  assert.equal(rows[2].status, '', 'missing category does not make balance incomplete');
  assert.equal(rows[3].status, '');
  assert.equal(rows[4].status, '金额待补全；余额不完整');
});
