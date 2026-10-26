'use strict';
/** 月报计算：使用 PRD 第 7 节的验收数字（测试示例，不是真实账目）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { plain } = require('./helpers/gas');

function rowsOf(section) {
  return plain(section.rows).map((r) => [r.name, r.cents, r.percent_tenths]);
}

test('支出构成：餐饮 120、购物 80 → 总支出 200；60.0% / 40.0%', () => {
  const t = setup();
  t.expense('120', '餐饮', '2026-01-10T12:00');
  t.expense('80', '购物', '2026-01-11T12:00');
  const r = t.report('2026-01');
  assert.equal(r.expense.total_cents, 20000);
  assert.deepEqual(rowsOf(r.expense), [['餐饮', 12000, 600], ['购物', 8000, 400]]);
  assert.equal(t.g.formatPercentTenths(r.expense.rows[0].percent_tenths), '60.0%');
});

test('收入来源：兼职 A 600、兼职 B 400 → 收入 1,000；兼职 100%；A 60.0%、B 40.0%', () => {
  const t = setup();
  t.income('600', '兼职', '2026-01-05T09:00', { new_source_name: '兼职 A' });
  const b = t.income('400', '兼职', '2026-01-06T09:00', { new_source_name: '兼职 B' });
  assert.equal(b.source_name, '兼职 B');
  const r = t.report('2026-01');
  assert.equal(r.income.total_cents, 100000);
  assert.deepEqual(rowsOf(r.income), [['兼职', 100000, 1000]]);
  assert.deepEqual(plain(r.income.rows[0].sources).map((s) => [s.name, s.cents, s.percent_tenths]),
    [['兼职 A', 60000, 600], ['兼职 B', 40000, 400]]);
});

test('收支对比：收入 1,000、支出 200、差额 800；柱子同一刻度', () => {
  const t = setup();
  t.expense('120', '餐饮', '2026-01-10T12:00');
  t.expense('80', '购物', '2026-01-11T12:00');
  t.income('600', '兼职', '2026-01-05T09:00', { new_source_name: '兼职 A' });
  t.income('400', '兼职', '2026-01-06T09:00', { new_source_name: '兼职 B' });
  const c = t.report('2026-01').comparison;
  assert.equal(c.income_cents, 100000);
  assert.equal(c.expense_cents, 20000);
  assert.equal(c.diff_cents, 80000);
  assert.equal(c.income_bar_tenths, 1000);
  assert.equal(c.expense_bar_tenths, 200);
});

test('待补全不计入金额和分母；补填 50 后总支出 250，占比更新', () => {
  const t = setup();
  t.expense('120', '餐饮', '2026-01-10T12:00');
  t.expense('80', '购物', '2026-01-11T12:00');
  const p = t.autoPending('日用', '2026-01-12T12:00');
  let r = t.report('2026-01');
  assert.equal(r.expense.total_cents, 20000, '合计仍为 200');
  assert.equal(r.pending_count, 1);
  assert.deepEqual(rowsOf(r.expense), [['餐饮', 12000, 600], ['购物', 8000, 400]]);
  const banner = t.g.svcListMonth(t.repo, '2026-01').banner;
  assert.deepEqual(plain(banner), { pending: 1, review: 0 });
  const list = t.g.svcListMonth(t.repo, '2026-01');
  const view = list.days.flatMap((d) => d.entries).find((e) => e.id === p.id);
  assert.equal(view.amount_cents, null);
  assert.equal(view.status_label, '待补全');

  // 补填（编辑这笔自动记录，只填金额，其他保持不变）
  const filled = t.save({ id: p.id, amount: '50', category_id: p.category_id, local_datetime: t.g.localNY(p.occurred_at), merchant: p.merchant });
  assert.equal(filled.status, 'normal');
  assert.equal(filled.channel, 'apple_pay', '记录渠道不变');
  r = t.report('2026-01');
  assert.equal(r.pending_count, 0);
  assert.equal(r.expense.total_cents, 25000);
  assert.deepEqual(rowsOf(r.expense), [['餐饮', 12000, 480], ['购物', 8000, 320], ['日用', 5000, 200]]);
  assert.deepEqual(plain(t.g.svcListMonth(t.repo, '2026-01').banner), { pending: 0, review: 0 });
});

test('退款：1 月餐饮 120，2 月退款 20（关联原交易）→ 1 月餐饮 120，2 月餐饮 −20', () => {
  const t = setup();
  const orig = t.expense('120', '餐饮', '2026-01-10T12:00', { merchant: 'DoorDash' });
  const refund = t.save({ type: 'expense', is_refund: true, refund_of: orig.id, amount: '20', local_datetime: '2026-02-03T10:00' });
  assert.equal(refund.amount_cents, -2000, '退款存为负数');
  assert.equal(refund.category_name, '餐饮', '类别默认与原交易相同');
  assert.equal(refund.month_ny, '2026-02', '按退款日期归月');
  assert.match(refund.refund_of_label, /DoorDash/);
  const jan = t.report('2026-01');
  assert.deepEqual(rowsOf(jan.expense), [["餐饮", 12000, 1000]]);
  assert.equal(jan.expense.total_cents, 12000);
  const janOrig = t.g.svcGetEntry(t.repo, orig.id);
  assert.equal(janOrig.amount_cents, 12000, '原账目不变');
  const feb = t.report('2026-02');
  assert.equal(feb.expense.total_cents, -2000);
  assert.deepEqual(plain(feb.expense.rows).map((r) => [r.name, r.cents, r.net_refund]), [['餐饮', -2000, true]]);
  assert.equal(feb.expense.show_percent, false, '支出总额 ≤ 0 时不显示百分比');
});

test('同月退款在类别内抵扣：餐饮 120 − 20 = 100，购物 100 → 各 50.0%', () => {
  const t = setup();
  const orig = t.expense('120', '餐饮', '2026-03-01T12:00');
  t.expense('100', '购物', '2026-03-02T12:00');
  t.save({ type: 'expense', is_refund: true, refund_of: orig.id, amount: '20', local_datetime: '2026-03-05T10:00' });
  const r = t.report('2026-03');
  assert.equal(r.expense.total_cents, 20000);
  assert.deepEqual(rowsOf(r.expense).map((x) => x[2]), [500, 500]);
});

test('百分比四舍五入：合计可能是 99.9% 或 100.1%', () => {
  const t = setup();
  t.expense('1', '餐饮', '2026-01-01T10:00');
  t.expense('1', '购物', '2026-01-01T11:00');
  t.expense('1', '交通', '2026-01-01T12:00');
  const r = t.report('2026-01');
  const tenths = plain(r.expense.rows).map((x) => x.percent_tenths);
  assert.deepEqual(tenths, [333, 333, 333]);
  assert.equal(tenths.reduce((a, b) => a + b, 0), 999);
});

test('未指定来源、收入与支出分开、删除的账目不计入', () => {
  const t = setup();
  t.income('100', '工资', '2026-01-01T10:00');
  const del = t.expense('999', '娱乐', '2026-01-02T10:00');
  t.g.svcDeleteEntry(t.repo, del.id, t.now());
  const r = t.report('2026-01');
  assert.equal(r.expense.total_cents, 0);
  assert.equal(r.income.rows[0].sources[0].name, '未指定来源');
  assert.equal(r.income.rows[0].sources[0].percent_tenths, 1000);
});

test('月份归属：费城 1 月 31 日 23:30 的账目计入 1 月报表', () => {
  const t = setup();
  const e = t.expense('10', '餐饮', '2026-01-31T23:30');
  assert.equal(e.month_ny, '2026-01');
  assert.equal(t.report('2026-01').expense.total_cents, 1000);
  assert.equal(t.report('2026-02').expense.total_cents, 0);
});

test('月报默认显示上个月；“生成于 / 最后更新于”', () => {
  const t = setup('2026-02-01T05:30:00Z'); // 费城 2 月 1 日 00:30
  assert.equal(t.g.svcBootstrap(t.repo, t.now()).report_default_month, '2026-01');
  t.setNow('2026-02-01T04:59:00Z'); // 费城 1 月 31 日 23:59
  assert.equal(t.g.svcBootstrap(t.repo, t.now()).report_default_month, '2025-12');
  t.setNow('2026-02-10T15:00:00Z');
  t.expense('5', '餐饮', '2026-01-20T12:00');
  const r = t.report('2026-01');
  assert.equal(r.generated_on, '2026-02-01');
  assert.equal(r.last_changed_local, '2026-02-10T10:00');
  assert.equal(t.report('2026-02').generated_on, null, '本月进行中');
});

test('账目列表的本月汇总 totals：与月报同口径，不受“只看待处理”筛选影响', () => {
  const t = setup();
  t.expense('120', '餐饮', '2026-01-10T12:00');
  t.income('600', '兼职', '2026-01-05T09:00', { new_source_name: '兼职 A' });
  t.autoPending('日用', '2026-01-12T12:00');
  const rep = t.report('2026-01');
  for (const filter of [undefined, 'attention']) {
    const totals = plain(t.g.svcListMonth(t.repo, '2026-01', filter).totals);
    assert.deepEqual(totals, { expense_cents: 12000, income_cents: 60000, diff_cents: 48000, pending_count: 1 });
    assert.equal(totals.expense_cents, rep.expense.total_cents);
    assert.equal(totals.diff_cents, rep.comparison.diff_cents);
  }
});

test('支出构成：仍是“未分类”的 Apple Pay 单独显示为“Apple Pay”；改过类别的按所选类别；手动记的未分类仍是“未分类”', () => {
  const t = setup();
  const applePay = (cents, local, categoryName) => {
    const e = t.autoPending(categoryName || '未分类', local);
    t.repo.update('entries', e.id, { amount_cents: cents });
  };
  applePay(1500, '2026-01-02T12:00');
  applePay(2500, '2026-01-03T12:00');
  applePay(3000, '2026-01-04T12:00', '餐饮');
  t.expense('7', '未分类', '2026-01-05T12:00');
  const r = t.report('2026-01');
  assert.equal(r.expense.total_cents, 7700, '总额不变');
  assert.deepEqual(rowsOf(r.expense).map((x) => [x[0], x[1]]), [['Apple Pay', 4000], ['餐饮', 3000], ['未分类', 700]]);
});
