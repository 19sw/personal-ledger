'use strict';
/**
 * 网页测试（消费习惯，2026-10-23）：报表 → 消费习惯。本月同期 vs 上月同期的类别对比、最近 3 个完整月的类别变化。
 * 服务器时钟固定（createBackend 的 now），jsdom 打开真实页面，后端是真实服务器代码 + 假表格。数字均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');

// 费城 2026-03-15 中午（夏令时，UTC−4）
const MAR15 = '2026-03-15T16:00:00Z';

async function openHabits(app) {
  app.nav('report');
  await app.until(() => app.$('#report-tabs'), '报表');
  app.click(app.$('#report-tabs [data-tab="habits"]'));
  await app.until(() => app.$$('#page-report .card').length === 2, '消费习惯');
}

/** 表格每行 → [类别, 各列文字…] */
function tableRows(app, index) {
  const table = app.$$('#page-report .insights-table')[index];
  return table ? Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent)) : null;
}

function seed(backend) {
  const { g, ss } = backend;
  const save = (type, amount, category_id, local, extra = {}) => g.api_saveEntry(Object.assign({ type, amount, category_id, local_datetime: local }, extra));
  const entries = () => g.sheetRepo_(ss).list('entries');
  const pending = (category_id, local) => {
    const d = g.parseLocalNY(local);
    g.sheetRepo_(ss).insert('entries', { id: 'p-' + local, type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
      date_ny: g.dateNY(d), category_id, merchant: 'Apple Pay', channel: 'apple_pay', source_key: 'ap:' + local,
      created_at: d.toISOString(), updated_at: d.toISOString() });
  };
  // Apple Pay 自动记下的账目（有金额）；category_id 默认“未分类”，也可以是手动改过的类别
  const applePay = (cents, local, category_id = 'exp_uncategorized') => {
    const d = g.parseLocalNY(local);
    g.sheetRepo_(ss).insert('entries', { id: 'ap-' + local, type: 'expense', amount_cents: cents, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
      date_ny: g.dateNY(d), category_id, merchant: 'Apple Pay', channel: 'apple_pay', source_key: 'ap:' + local,
      created_at: d.toISOString(), updated_at: d.toISOString() });
  };
  return { save, entries, pending, applePay };
}

test('消费习惯：本月 1–15 日与上月 1–15 日按类别对比；退款抵扣、待补全只计数、已删除和区间外的不算', async () => {
  const app = await openApp({ backend: { now: MAR15 } });
  const { save, entries, pending } = seed(app.backend);
  // 本月同期（3 月 1–15 日）
  save('expense', '120', 'exp_dining', '2026-03-02T12:00');
  const meal = entries().find((e) => e.amount_cents === 12000);
  save('expense', '20', 'exp_dining', '2026-03-10T12:00', { is_refund: true, refund_of: meal.id });
  save('expense', '80', 'exp_shopping', '2026-03-05T12:00');
  pending('exp_dining', '2026-03-08T12:00');
  save('expense', '50', 'exp_dining', '2026-03-20T12:00');          // 本月 15 日之后：不算
  save('expense', '30', 'exp_transport', '2026-03-03T12:00');
  app.backend.g.api_deleteEntry(entries().find((e) => e.amount_cents === 3000).id);   // 已删除：不算
  save('income', '3000', 'inc_salary', '2026-03-01T09:00');         // 收入：不算
  // 上月同期（2 月 1–15 日）
  save('expense', '60', 'exp_dining', '2026-02-03T12:00');
  save('expense', '40', 'exp_transport', '2026-02-10T12:00');
  save('expense', '999', 'exp_shopping', '2026-02-20T12:00');       // 上月 15 日之后：不算

  await openHabits(app);
  const card = app.$$('#page-report .card')[0];
  assert.match(card.textContent, /2026-03-01 至 2026-03-15/);
  assert.match(card.textContent, /2026-02-01 至 2026-02-15/);
  assert.match(card.textContent, /有 1 笔支出金额未补全/);
  assert.deepEqual(tableRows(app, 0), [
    ['餐饮', '$100.00', '$60.00', '+$40.00'],
    ['购物', '$80.00', '$0.00', '+$80.00'],
    ['交通', '$0.00', '$40.00', '-$40.00']
  ], '按本月同期金额从高到低');
  assert.ok(app.$('#report-tabs [data-tab="habits"]').classList.contains('on'));
  assert.deepEqual(app.errors, []);
});

test('消费习惯：月底时上月天数不足取上月最后一天（3 月 31 日 → 2 月 28 日）', async () => {
  const app = await openApp({ backend: { now: '2026-03-31T16:00:00Z' } });
  const { save } = seed(app.backend);
  save('expense', '25', 'exp_dining', '2026-02-28T20:00');
  save('expense', '10', 'exp_dining', '2026-03-31T09:00');
  await openHabits(app);
  assert.match(app.text('#page-report .card'), /2026-02-01 至 2026-02-28/);
  assert.deepEqual(tableRows(app, 0), [['餐饮', '$10.00', '$25.00', '-$15.00']]);
});

test('消费习惯：最近 3 个完整月（12、1、2 月）按类别列出，按 3 个月合计从高到低排；没有记录的月份显示 —，本月不算；待补全另行提示', async () => {
  const app = await openApp({ backend: { now: MAR15 } });
  const { save, pending } = seed(app.backend);
  save('expense', '1000', 'exp_housing', '2025-12-01T09:00');
  save('expense', '1000', 'exp_housing', '2026-02-01T09:00');
  save('expense', '45.5', 'exp_dining', '2026-01-12T12:00');
  save('expense', '200', 'exp_shopping', '2025-12-05T12:00');
  save('expense', '100', 'exp_shopping', '2026-02-05T12:00');
  save('expense', '20', 'exp_transport', '2026-02-07T12:00');
  save('expense', '20', 'exp_coffee_tea', '2026-01-07T12:00');   // 与交通合计相同：按名称排
  save('expense', '500', 'exp_housing', '2025-11-01T09:00');   // 11 月：超出 3 个月
  save('expense', '70', 'exp_shopping', '2026-03-02T12:00');   // 本月：不在完整月里
  pending('exp_dining', '2026-01-20T12:00');
  await openHabits(app);
  const head = Array.from(app.$$('#page-report .insights-table')[1].querySelectorAll('thead th')).map((th) => th.textContent);
  assert.deepEqual(head, ['消费类别', '2025-12', '2026-01', '2026-02']);
  const rows = tableRows(app, 1);
  const tie = ['交通', '咖啡奶茶'].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(rows.map((r) => r[0]), ['住房', '购物', '餐饮'].concat(tie), '按 3 个月合计：2000、300、45.5、20、20');
  assert.deepEqual(rows[0], ['住房', '$1,000.00', '—', '$1,000.00'], '11 月和本月的住房不算');
  assert.deepEqual(rows[1], ['购物', '$200.00', '—', '$100.00'], '本月的购物不算');
  assert.deepEqual(rows[2], ['餐饮', '—', '$45.50', '—']);
  assert.match(app.$$('#page-report .card')[1].textContent, /这 3 个月有 1 笔账目金额未补全/);
});

test('消费习惯：没有任何消费时两张卡片都显示空状态', async () => {
  const app = await openApp({ backend: { now: MAR15 } });
  await openHabits(app);
  assert.match(app.text('#page-report'), /这两个区间还没有已知金额的消费/);
  assert.match(app.text('#page-report'), /最近 3 个完整月还没有已知金额的消费/);
  assert.equal(app.$$('#page-report .insights-table').length, 0);
  assert.deepEqual(app.errors, []);
});

test('消费习惯：读取失败时显示原因和“重新读取”，重新读取成功后显示表格', async () => {
  const app = await openApp({ backend: { now: MAR15 } });
  const { g } = app.backend;
  const { save } = seed(app.backend);
  save('expense', '12', 'exp_dining', '2026-03-02T12:00');
  app.nav('report');
  await app.until(() => app.$('#report-tabs'), '报表');
  const real = g.api_listMonth;
  g.api_listMonth = () => { throw new Error('暂时连不上账本'); };
  app.click(app.$('#report-tabs [data-tab="habits"]'));
  await app.until(() => app.$('#page-report .warnbox'), '错误提示');
  assert.match(app.text('#page-report .warnbox'), /暂时连不上账本/);
  g.api_listMonth = real;
  app.click(app.$('[data-act="habits-refresh"]'));
  await app.until(() => tableRows(app, 0), '重新读取后的表格');
  assert.deepEqual(tableRows(app, 0), [['餐饮', '$12.00', '$0.00', '+$12.00']]);
});

test('消费习惯：仍是“未分类”的 Apple Pay 账目单独显示为“Apple Pay”；手动改过类别的按手动类别；手动记的未分类仍是“未分类”', async () => {
  const app = await openApp({ backend: { now: MAR15 } });
  const { save, applePay } = seed(app.backend);
  // 本月同期
  applePay(1500, '2026-03-02T12:00');                    // 未分类 Apple Pay → Apple Pay
  applePay(2500, '2026-03-04T12:00', 'exp_dining');      // 手动改成餐饮 → 餐饮
  save('expense', '7', 'exp_uncategorized', '2026-03-05T12:00');   // 手动记的未分类 → 未分类
  // 上月同期
  applePay(1000, '2026-02-03T12:00');
  // 最近 3 个完整月
  applePay(4000, '2026-01-10T12:00');
  applePay(300, '2026-01-11T12:00', 'exp_dining');
  await openHabits(app);
  assert.deepEqual(tableRows(app, 0), [
    ['餐饮', '$25.00', '$0.00', '+$25.00'],
    ['Apple Pay', '$15.00', '$10.00', '+$5.00'],
    ['未分类', '$7.00', '$0.00', '+$7.00']
  ]);
  assert.deepEqual(tableRows(app, 1), [
    ['Apple Pay', '—', '$40.00', '$10.00'],
    ['餐饮', '—', '$3.00', '—']
  ]);
  assert.deepEqual(app.errors, []);
});
