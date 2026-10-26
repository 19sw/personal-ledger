'use strict';
/** 账单（报表 → 账单）：月账单 / 年账单与月报口径一致。数字均为测试示例。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { plain } = require('./helpers/gas');

/** 2025 年与 2026 年的测试账目；“现在”是 2026 年 3 月 20 日（费城）。 */
function fixture() {
  const t = setup('2026-03-20T15:00:00Z');
  t.income('3000', '工资', '2025-01-15T09:00');
  t.expense('1200', '住房', '2025-01-01T09:00');
  const orig = t.expense('120', '餐饮', '2025-06-10T12:00');
  t.expense('20', '餐饮', '2025-07-02T12:00', { is_refund: true, refund_of: orig.id });  // 退款冲减 7 月
  t.autoPending('餐饮', '2025-07-05T12:00');                                            // 待补全：只计数
  const del = t.expense('999', '购物', '2025-08-01T12:00');
  t.g.svcDeleteEntry(t.repo, del.id, t.now());                                          // 删除：不计入
  t.expense('45', '交通', '2025-12-31T23:30');                                          // 费城 12 月 31 日 → 2025 年
  t.income('3000', '工资', '2026-01-15T09:00');
  t.expense('80', '购物', '2026-02-11T12:00');
  t.expense('60', '餐饮', '2026-03-05T12:00');
  t.expense('500', '旅行', '2026-05-01T12:00');                                         // 提前录入的 5 月：今天之后的月份不列
  return t;
}

test('月账单：每个月的数字与 computeReport 完全一致；新的月份在前', () => {
  const t = fixture();
  const b = t.g.svcGetMonthBills(t.repo, '2025', t.now());
  assert.equal(b.months.length, 12);
  assert.deepEqual(plain(b.months.map((m) => m.month)).slice(0, 3), ['2025-12', '2025-11', '2025-10']);
  for (const m of b.months) {
    const r = t.report(m.month);
    assert.deepEqual(plain(m), { month: m.month, income_cents: r.income.total_cents, expense_cents: r.expense.total_cents,
      diff_cents: r.comparison.diff_cents, pending_count: r.pending_count }, m.month);
  }
  const jul = b.months.find((m) => m.month === '2025-07');
  assert.equal(jul.expense_cents, -2000, '7 月只有退款：净额为负');
  assert.equal(jul.pending_count, 1);
  assert.equal(b.months.find((m) => m.month === '2025-08').expense_cents, 0, '删除的不计入');
  assert.equal(b.months.find((m) => m.month === '2025-12').expense_cents, 4500);
  // 年合计 = 各月相加
  assert.equal(b.income_cents, 300000);
  assert.equal(b.expense_cents, 120000 + 12000 - 2000 + 4500);
  assert.equal(b.diff_cents, b.income_cents - b.expense_cents);
  assert.equal(b.pending_count, 1, '有待补全时提示统计不完整');
});

test('月账单：今年只列到本月；以后的年份没有月份；年份列表包括今年', () => {
  const t = fixture();
  const b = t.g.svcGetMonthBills(t.repo, '2026', t.now());
  assert.deepEqual(plain(b.months.map((m) => m.month)), ['2026-03', '2026-02', '2026-01']);
  assert.equal(b.expense_cents, 8000 + 6000, '5 月提前录入的账目不在今年账单里');
  assert.equal(b.pending_count, 0);
  assert.deepEqual(plain(b.years), ['2026', '2025']);
  assert.equal(t.g.svcGetMonthBills(t.repo, '2027', t.now()).months.length, 0);
  assert.throws(() => t.g.svcGetMonthBills(t.repo, '26', t.now()), /年份格式/);
});

test('年账单：每个有账目的年份一行（由月账单相加），总计；待补全提示', () => {
  const t = fixture();
  const y = t.g.svcGetYearBills(t.repo, t.now());
  assert.deepEqual(plain(y.years).map((r) => r.year), ['2026', '2025']);
  const y25 = t.g.svcGetMonthBills(t.repo, '2025', t.now());
  const y26 = t.g.svcGetMonthBills(t.repo, '2026', t.now());
  assert.deepEqual(plain(y.years[1]), { year: '2025', income_cents: y25.income_cents, expense_cents: y25.expense_cents,
    diff_cents: y25.diff_cents, pending_count: 1 });
  assert.equal(y.years[0].expense_cents, y26.expense_cents);
  assert.equal(y.income_cents, y25.income_cents + y26.income_cents);
  assert.equal(y.expense_cents, y25.expense_cents + y26.expense_cents);
  assert.equal(y.diff_cents, y.income_cents - y.expense_cents);
  assert.equal(y.pending_count, 1);
});

test('年账单：没有账目时为空；只有删除的账目的年份不列', () => {
  const t = setup('2026-03-20T15:00:00Z');
  assert.deepEqual(plain(t.g.svcGetYearBills(t.repo, t.now()).years), []);
  const e = t.expense('10', '餐饮', '2024-05-01T12:00');
  t.g.svcDeleteEntry(t.repo, e.id, t.now());
  assert.deepEqual(plain(t.g.svcGetYearBills(t.repo, t.now()).years), []);
});

test('月账单：从该年第一个有账目的月份开始列；没有账目的年份不提供；年合计不变', () => {
  const t = setup('2026-03-20T15:00:00Z');
  t.expense('10', '餐饮', '2025-04-10T12:00');
  t.expense('20', '餐饮', '2025-09-10T12:00');
  const del = t.expense('5', '餐饮', '2025-02-10T12:00');
  t.g.svcDeleteEntry(t.repo, del.id, t.now());                         // 删除的不算“有账目”
  t.expense('30', '餐饮', '2026-02-10T12:00');
  const b25 = t.g.svcGetMonthBills(t.repo, '2025', t.now());
  assert.equal(b25.months.length, 9);
  assert.equal(b25.months[b25.months.length - 1].month, '2025-04');
  assert.equal(b25.expense_cents, 3000);
  const b26 = t.g.svcGetMonthBills(t.repo, '2026', t.now());
  assert.deepEqual(plain(b26.months.map((m) => m.month)), ['2026-03', '2026-02']);
  assert.equal(b26.months.length, 2);
  assert.deepEqual(plain(t.g.svcGetMonthBills(t.repo, '2024', t.now()).months), []);
  assert.ok(!plain(b26.years).includes('2024'));
});
