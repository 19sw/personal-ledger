'use strict';
/**
 * 预算规则（PRD 6A.1、spec 7A.1 / 7A.2 / 7A.6 中与小助手无关的部分）。数字均为测试示例。
 * 用与网页相同的入口（svcSetBudget / svcGetBudgets / svcGetReport）测试，repo 为内存版。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { loadGas, memoryRepo, idGen, plain } = require('./helpers/gas');

function budgetSetup(nowIso) {
  const t = setup(nowIso);
  t.setBudget = (scope, amount) => t.g.svcSetBudget(t.repo, scope, amount, t.now(), t.newId);
  t.budgets = (month) => t.g.svcGetBudgets(t.repo, month, t.now());
  t.rows = () => plain(t.repo.list('budgets'));
  t.lookup = (scope, month) => t.g.effectiveBudget(t.repo.list('budgets'), scope, month);
  return t;
}

test('预算沿用：1 月 100000 → 2 月查到 100000；2 月 15 日改为 120000 → 追加 2 月行，1 月仍为 100000', () => {
  const t = budgetSetup('2026-01-10T15:00:00Z');
  t.setBudget('total', '1000');
  assert.deepEqual(t.rows().map((r) => [r.scope, r.amount_cents, r.effective_from]), [['total', 100000, '2026-01']]);
  assert.equal(t.lookup('total', '2026-02'), 100000, '2 月沿用');
  assert.equal(t.lookup('total', '2025-12'), null, '设置之前的月份没有预算');

  t.setNow('2026-02-15T17:00:00Z');
  const janRowBefore = t.rows()[0];
  t.setBudget('total', '1200');
  assert.deepEqual(t.rows().map((r) => [r.scope, r.amount_cents, r.effective_from]),
    [['total', 100000, '2026-01'], ['total', 120000, '2026-02']]);
  assert.equal(t.lookup('total', '2026-01'), 100000);
  assert.equal(t.lookup('total', '2026-02'), 120000);
  assert.equal(t.lookup('total', '2026-07'), 120000);

  // 同一个月再改：更新 2 月这一行，不追加；1 月那一行一个字都不变
  t.setBudget('total', '1300');
  assert.equal(t.rows().length, 2);
  assert.deepEqual(t.rows()[0], janRowBefore, '过去月份的行从不修改');
  assert.equal(t.lookup('total', '2026-02'), 130000);
  assert.equal(t.budgets('2026-01').total.budget_cents, 100000, '过去月份显示当时的预算');
});

test('网页不能指定月份：修改总是写入服务器当前的费城月份（1 月 31 日 23:30 费城时间仍是 1 月）', () => {
  const t = budgetSetup('2026-02-01T04:30:00Z');   // 费城 1 月 31 日 23:30
  t.setBudget('total', '500');
  assert.equal(t.rows()[0].effective_from, '2026-01');
});

test('未分类：服务器拒绝给“未分类”设预算；未分类支出 5000 计入总预算已用', () => {
  const t = budgetSetup('2026-03-10T15:00:00Z');
  assert.throws(() => t.setBudget(t.cat('未分类'), '50'), /未分类/);
  assert.throws(() => t.setBudget('uncategorized', '50'), /找不到这个类别/);
  assert.equal(t.rows().length, 0, '被拒绝时什么都不写');
  t.setBudget('total', '1000');
  t.expense('50', '未分类', '2026-03-05T12:00');
  const v = t.budgets('2026-03');
  assert.equal(v.total.used_cents, 5000);
  assert.equal(v.total.remaining_cents, 95000);
});

test('其他非法范围与金额都被拒绝：收入类别、已删除类别、不存在；0、负数、乱码', () => {
  const t = budgetSetup('2026-03-10T15:00:00Z');
  assert.throws(() => t.setBudget(t.cat('工资', 'income'), '50'), /只能给支出类别/);
  t.g.svcArchiveCategory(t.repo, t.cat('娱乐'), t.now(), t.newId);
  assert.throws(() => t.setBudget(t.cat('娱乐'), '50'), /已删除/);
  assert.throws(() => t.setBudget('nope', '50'), /找不到/);
  assert.throws(() => t.setBudget('total', '0'), /大于 0/);
  assert.throws(() => t.setBudget('total', '-5'), /大于 0/);
  assert.throws(() => t.setBudget('total', 'abc'), /格式不正确/);
  assert.throws(() => t.setBudget('total', '1.234'), /格式不正确/);
  assert.equal(t.rows().length, 0);
});

test('退款冲减已用；待补全不计入已用、单独计数并附注', () => {
  const t = budgetSetup('2026-03-20T15:00:00Z');
  t.setBudget('total', '1000');
  t.setBudget(t.cat('餐饮'), '200');
  const orig = t.expense('120', '餐饮', '2026-03-05T12:00');
  t.expense('20', '餐饮', '2026-03-08T12:00', { is_refund: true, refund_of: orig.id });
  let v = t.budgets('2026-03');
  assert.equal(v.total.used_cents, 10000);
  assert.equal(v.categories[0].used_cents, 10000);
  assert.equal(v.pending_count, 0);

  t.autoPending('餐饮', '2026-03-09T12:00');
  v = t.budgets('2026-03');
  assert.equal(v.total.used_cents, 10000, '待补全不算 0、不计入');
  assert.equal(v.pending_count, 1);
  assert.equal(v.categories[0].pending_count, 1);
  assert.equal(v.total.pending_count, 1);
  // 删除的账目不计入
  const del = t.expense('50', '餐饮', '2026-03-10T12:00');
  t.g.svcDeleteEntry(t.repo, del.id, t.now());
  assert.equal(t.budgets('2026-03').total.used_cents, 10000);
  // 收入不计入预算
  t.income('500', '工资', '2026-03-10T12:00');
  assert.equal(t.budgets('2026-03').total.used_cents, 10000);
});

test('退款按退款日期归月：2 月收到 1 月订单的退款，冲减 2 月已用', () => {
  const t = budgetSetup('2026-02-20T15:00:00Z');
  const orig = t.expense('120', '餐饮', '2026-01-10T12:00');
  t.expense('20', '餐饮', '2026-02-03T12:00', { is_refund: true, refund_of: orig.id });
  const rows = [{ scope: 'total', amount_cents: 100000, effective_from: '2026-01' }];
  const g = t.g;
  assert.equal(g.computeBudgetView(t.repo.list('entries'), t.repo.list('categories'), rows, '2026-01', 80).total.used_cents, 12000);
  assert.equal(g.computeBudgetView(t.repo.list('entries'), t.repo.list('categories'), rows, '2026-02', 80).total.used_cents, -2000);
  assert.equal(g.computeBudgetView(t.repo.list('entries'), t.repo.list('categories'), rows, '2026-02', 80).total.used_pct, 0);
});

test('阈值用整数比较：79.99% 不算接近，80% 算接近；100% 仍是接近，超过才是超出', () => {
  const g = loadGas();
  assert.equal(g.budgetState(7999, 10000, 80), 'ok');
  assert.equal(g.budgetState(8000, 10000, 80), 'near');
  assert.equal(g.budgetState(15998, 20000, 80), 'ok');      // 79.99%
  assert.equal(g.budgetState(16000, 20000, 80), 'near');
  assert.equal(g.budgetState(17000, 20000, 80), 'near');    // spec 7A.6：餐饮已用 85%
  assert.equal(g.budgetUsedPct(17000, 20000), 85);
  assert.equal(g.budgetState(17000, 100000, 80), 'ok');     // 总预算 17% → 不提醒
  assert.equal(g.budgetUsedPct(17000, 100000), 17);
  assert.equal(g.budgetState(20000, 20000, 80), 'near');
  assert.equal(g.budgetState(20001, 20000, 80), 'over');
  assert.equal(g.budgetState(17000, 20000, 90), 'ok', '比例可调');
  // 显示用的整数百分比四舍五入：79.5% → 80%，但状态仍按精确比较是 ok
  assert.equal(g.budgetUsedPct(7950, 10000), 80);
  assert.equal(g.budgetState(7950, 10000, 80), 'ok');
  assert.equal(g.budgetUsedPct(-500, 10000), 0);
});

test('预算页数字：剩余、剩余比例、超出；剩余天数（今天算已过去）', () => {
  const t = budgetSetup('2026-02-20T15:00:00Z');   // 费城 2 月 20 日
  t.setBudget('total', '1000');
  t.setBudget(t.cat('餐饮'), '200');
  t.setBudget(t.cat('购物'), '100');
  t.expense('170', '餐饮', '2026-02-05T12:00');
  t.expense('130', '购物', '2026-02-06T12:00');
  const v = t.budgets('2026-02');
  assert.equal(v.days_in_month, 28);
  assert.equal(v.days_left, 8);
  assert.equal(v.editable, true);
  assert.deepEqual(plain(v.total), { scope: 'total', name: '总预算', budget_cents: 100000, used_cents: 30000, remaining_cents: 70000,
    used_pct: 30, remaining_pct: 70, state: 'ok', pending_count: 0 });
  const [dining, shopping] = v.categories;
  assert.equal(dining.name, '餐饮');
  assert.equal(dining.state, 'near');
  assert.equal(dining.used_pct, 85);
  assert.equal(shopping.state, 'over');
  assert.equal(shopping.remaining_cents, -3000);
  assert.equal(shopping.remaining_pct, 0);
  // 过去月份：只读；没有剩余天数
  const jan = t.budgets('2026-01');
  assert.equal(jan.editable, false);
  assert.equal(jan.days_left, null);
  assert.equal(jan.total, null);
  // 比例可调：改为 90 后餐饮（85%）不再接近
  t.g.svcSetBudgetNearPct(t.repo, 90);
  assert.equal(t.budgets('2026-02').categories[0].state, 'ok');
});

test('取消：空金额 = 从本月起取消；同月则把本月那一行改为空；本来就没有预算时不写入', () => {
  const t = budgetSetup('2026-01-10T15:00:00Z');
  t.setBudget('total', '');
  assert.equal(t.rows().length, 0, '没有预算时取消不写任何东西');
  t.setBudget('total', '1000');
  t.setNow('2026-03-02T15:00:00Z');
  t.setBudget('total', '   ');
  assert.deepEqual(t.rows().map((r) => [r.amount_cents, r.effective_from]), [[100000, '2026-01'], [null, '2026-03']]);
  assert.equal(t.lookup('total', '2026-02'), 100000, '过去月份不变');
  assert.equal(t.lookup('total', '2026-03'), null);
  assert.equal(t.lookup('total', '2026-04'), null, '取消也会沿用');
  assert.equal(t.budgets('2026-03').total, null);
  // 同月重新设置，再同月取消：只改 3 月这一行
  t.setBudget('total', '800');
  t.setBudget('total', null);
  assert.equal(t.rows().length, 2);
  assert.equal(t.lookup('total', '2026-03'), null);
});

test('归档类别：从当月起写入取消行，过去月份不变；重新启用后预算保持取消', () => {
  const t = budgetSetup('2026-01-10T15:00:00Z');
  const dining = t.cat('餐饮');
  t.setBudget(dining, '200');
  t.setNow('2026-02-10T15:00:00Z');
  t.g.svcArchiveCategory(t.repo, dining, t.now(), t.newId);
  assert.deepEqual(t.rows().map((r) => [r.scope, r.amount_cents, r.effective_from]),
    [[dining, 20000, '2026-01'], [dining, null, '2026-02']]);
  assert.equal(t.lookup(dining, '2026-01'), 20000);
  assert.equal(t.lookup(dining, '2026-02'), null);
  assert.equal(t.budgets('2026-01').categories.length, 1, '过去月份仍显示当时的预算');
  assert.equal(t.budgets('2026-02').categories.length, 0);

  // 重新启用（“添加”同名类别会重新启用已删除的那个）
  t.setNow('2026-03-10T15:00:00Z');
  const re = t.g.svcAddCategory(t.repo, 'expense', '餐饮', t.newId);
  assert.equal(re.id, dining);
  assert.equal(re.archived, false);
  assert.equal(t.lookup(dining, '2026-03'), null, '不会自动恢复');
  assert.equal(t.budgets('2026-03').categories.length, 0);
  // 没有预算的类别归档时不写取消行
  t.g.svcArchiveCategory(t.repo, t.cat('娱乐'), t.now(), t.newId);
  assert.equal(t.rows().length, 2);
});

test('D10：类别预算之和高于总预算时提示，但照常保存', () => {
  const t = budgetSetup('2026-04-10T15:00:00Z');
  t.setBudget('total', '100');
  t.setBudget(t.cat('餐饮'), '80');
  const v = t.setBudget(t.cat('购物'), '50');
  assert.equal(v.category_sum_cents, 13000);
  assert.match(v.warning, /类别预算合计 \$130\.00，高于总预算 \$100\.00/);
  assert.equal(t.rows().length, 3, '已保存');
  t.setBudget(t.cat('购物'), '20');
  assert.equal(t.budgets('2026-04').warning, null);
});

test('预算提醒比例：只接受 50–100 的整数；setupLedger 写入默认 80 且不覆盖已改的值', () => {
  const t = budgetSetup('2026-04-10T15:00:00Z');
  assert.equal(t.g.readNearPct(t.repo.list('settings')), 80, '没有设置时默认 80');
  t.g.svcEnsureSettings(t.repo);
  assert.deepEqual(plain(t.repo.list('settings')), [{ key: 'budget_near_pct', value: '80' }]);
  for (const bad of [49, 101, '8x', 80.5, '', null, '-60']) {
    assert.throws(() => t.g.svcSetBudgetNearPct(t.repo, bad), /50–100/, String(bad));
  }
  t.g.svcSetBudgetNearPct(t.repo, '75');
  t.g.svcEnsureSettings(t.repo);
  assert.deepEqual(plain(t.repo.list('settings')), [{ key: 'budget_near_pct', value: '75' }]);
  assert.equal(t.g.svcBootstrap(t.repo, t.now()).budget_near_pct, 75);
  // 表格里被手动改成非法值：按默认 80 处理
  t.repo.update('settings', 'budget_near_pct', { value: '300' });
  assert.equal(t.g.readNearPct(t.repo.list('settings')), 80);
});

test('月报预算小结：使用该月当时有效的预算；没有预算时不显示；一句白话总结', () => {
  const t = budgetSetup('2026-02-10T15:00:00Z');
  t.expense('170', '餐饮', '2026-02-05T12:00');
  assert.equal(t.report('2026-02').budget, null, '没有任何预算时为 null');
  t.setBudget('total', '1000');
  t.setBudget(t.cat('餐饮'), '150');
  t.setBudget(t.cat('购物'), '100');
  t.expense('85', '购物', '2026-02-06T12:00');
  const r = t.report('2026-02');
  assert.equal(r.budget.view.total.remaining_cents, 74500);
  assert.equal(r.budget.summary, '总预算剩余 $745.00，餐饮超出 $20.00，购物已用 85%。');
  // 3 月修改不影响 2 月的小结
  t.setNow('2026-03-02T15:00:00Z');
  t.setBudget('total', '300');
  assert.equal(t.report('2026-02').budget.view.total.budget_cents, 100000);
  assert.equal(t.report('2026-03').budget.view.total.budget_cents, 30000);
});

test('budgets / settings 表还不存在（未重新运行 setupLedger）：读取当作没有预算，写入给出中文提示，归档类别照常', () => {
  const g = loadGas();
  const repo = memoryRepo(g, { without: ['budgets', 'settings'] });
  g.svcEnsureDefaults(repo);
  const now = new Date('2026-02-10T15:00:00Z');
  const newId = idGen('m');
  const boot = g.svcBootstrap(repo, now);
  assert.equal(boot.budget_ready, false);
  assert.equal(boot.budget_near_pct, 80);
  const v = g.svcGetBudgets(repo, '2026-02', now);
  assert.equal(v.total, null);
  assert.equal(v.editable, false);
  assert.equal(v.ready, false);
  assert.equal(g.svcGetReport(repo, '2026-02', now).budget, null);
  assert.throws(() => g.svcSetBudget(repo, 'total', '100', now, newId), /重新运行一次 setupLedger/);
  assert.throws(() => g.svcSetBudgetNearPct(repo, 90), /重新运行一次 setupLedger/);
  g.svcArchiveCategory(repo, 'exp_dining', now, newId);
  assert.equal(repo.has('budgets'), false, '不会自动建表');
  assert.equal(repo.list('categories').find((c) => c.id === 'exp_dining').archived, true);
});
