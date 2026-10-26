'use strict';
/**
 * 储蓄目标、存入记录和月底估算（2026-10-23 储蓄功能）。数字均为测试示例。
 * 用与网页相同的入口（svcGetSavings / svcSaveSavingsGoal / svcRecordSavingsContribution / svcSaveSavingsEstimates）测试，repo 为内存版。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { loadGas, memoryRepo, idGen, plain } = require('./helpers/gas');

// 费城 2026-05-15 中午（夏令时，UTC−4）
const MAY15 = '2026-05-15T16:00:00Z';

function savingsSetup(nowIso = MAY15) {
  const t = setup(nowIso);
  const goalId = idGen('g');
  t.view = () => plain(t.g.svcGetSavings(t.repo, t.now()));
  t.saveGoal = (input) => plain(t.g.svcSaveSavingsGoal(t.repo, input, t.now(), goalId));
  t.deposit = (input) => plain(t.g.svcRecordSavingsContribution(t.repo, input, t.now()));
  t.estimate = (input) => plain(t.g.svcSaveSavingsEstimates(t.repo, Object.assign({ month: t.view().current_month }, input), t.now()));
  t.goal = (name) => t.view().goals.find((g) => g.name === name);
  t.rows = (table) => plain(t.repo.list(table));
  return t;
}

const goal = (extra = {}) => Object.assign({ name: '旅行', target_amount: '1200', starting_saved_amount: '0', monthly_amount: '200' }, extra);

test('旧账本没有储蓄表：读取返回 ready=false 和空目标；三个写入都提示先运行 setupLedger，不建表', () => {
  const g = loadGas();
  const repo = memoryRepo(g, { without: ['savings_goals', 'savings_contributions', 'savings_estimates'] });
  g.svcEnsureDefaults(repo);
  const now = new Date(MAY15);
  const v = plain(g.svcGetSavings(repo, now));
  assert.equal(v.ready, false);
  assert.deepEqual(v.goals, []);
  assert.equal(v.current_month, '2026-05');
  assert.equal(v.forecast.can_estimate, false, '没有历史也没有估算：不能估算');
  assert.throws(() => g.svcSaveSavingsGoal(repo, goal(), now, idGen('g')), /setupLedger/);
  assert.throws(() => g.svcRecordSavingsContribution(repo, { request_id: 'req-00000001', goal_id: 'x', amount: '5' }, now), /setupLedger/);
  assert.throws(() => g.svcSaveSavingsEstimates(repo, { month: '2026-05', income_amount: '100' }, now), /setupLedger/);
  assert.equal(repo.has('savings_goals'), false);
});

test('新建目标：名称、目标金额、已存金额、月存款、日期的检查；被拒绝时什么都不写', () => {
  const t = savingsSetup();
  assert.throws(() => t.saveGoal(goal({ name: '  ' })), /1–60/);
  assert.throws(() => t.saveGoal(goal({ name: 'x'.repeat(61) })), /1–60/);
  assert.throws(() => t.saveGoal(goal({ target_amount: '0' })), /目标金额.*大于 0/);
  assert.throws(() => t.saveGoal(goal({ target_amount: 'abc' })), /目标金额/);
  assert.throws(() => t.saveGoal(goal({ starting_saved_amount: '-1' })), /已经存下的金额/);
  assert.throws(() => t.saveGoal(goal({ monthly_amount: '' })), /每月计划存入/, '没有日期时月存款必填');
  assert.throws(() => t.saveGoal(goal({ monthly_amount: '0' })), /大于 0/, '没有日期、未完成：月存款不能为 0');
  assert.throws(() => t.saveGoal(goal({ target_date: '2026-05-15' })), /今天之后/, '今天不算');
  assert.throws(() => t.saveGoal(goal({ target_date: '2026-02-30' })), /不存在/);
  assert.throws(() => t.saveGoal(goal({ target_date: '2026/06/01' })), /格式不正确/);
  assert.deepEqual(t.rows('savings_goals'), []);
});

test('新建目标：名称去掉多余空格；有日期且月存款留空时按剩余金额和月份建议（5–10 月共 6 个月）', () => {
  const t = savingsSetup();
  const v = t.saveGoal(goal({ name: '  日本   旅行 ', monthly_amount: '', target_date: '2026-10-31' }));
  assert.equal(v.goals.length, 1);
  const g = v.goals[0];
  assert.equal(g.name, '日本 旅行');
  assert.equal(g.target_cents, 120000);
  assert.equal(g.monthly_cents, 20000);
  assert.equal(g.months_to_deadline, 6);
  assert.equal(g.required_monthly_cents, 20000);
  assert.equal(g.monthly_plan_meets_deadline, true);
  assert.equal(g.completed, false);
  assert.equal(g.overdue, false);
  // 除不尽时向上取整到美分
  const v2 = t.saveGoal(goal({ name: '电脑', target_amount: '100', monthly_amount: '', target_date: '2026-07-01' }));
  assert.equal(v2.goals.find((x) => x.name === '电脑').monthly_cents, 3334, '10000 ÷ 3 个月 → 3334');
});

test('没有日期的目标：按月存款估算需要几个月、哪个月达成；已存金额计入进度', () => {
  const t = savingsSetup();
  t.saveGoal(goal({ starting_saved_amount: '300', monthly_amount: '200' }));
  const g = t.goal('旅行');
  assert.equal(g.saved_cents, 30000);
  assert.equal(g.remaining_cents, 90000);
  assert.equal(g.progress_tenths, 250, '25.0%');
  assert.equal(g.estimated_months, 5, '90000 ÷ 20000 → 5 个月');
  assert.equal(g.estimated_completion_month, '2026-09', '5 月起算的第 5 个月');
  assert.equal(g.months_to_deadline, null);
  assert.equal(g.required_monthly_cents, null);
  assert.equal(g.monthly_plan_meets_deadline, null);
});

test('修改目标：找不到的编号报错；保留存入记录；已过期的原日期可以不改，换成别的过去日期不行', () => {
  const t = savingsSetup('2026-03-10T16:00:00Z');
  t.saveGoal(goal({ target_date: '2026-04-30' }));
  const id = t.goal('旅行').id;
  t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '100' });
  assert.throws(() => t.saveGoal(goal({ id: 'nope' })), /找不到这个储蓄目标/);

  t.setNow(MAY15);   // 目标日期已过
  let g = t.goal('旅行');
  assert.equal(g.overdue, true);
  assert.equal(g.months_to_deadline, null);
  assert.equal(g.monthly_plan_meets_deadline, false);
  // 只改名字，日期原样提交：允许
  t.saveGoal(goal({ id, name: '旅行基金', target_date: '2026-04-30' }));
  g = t.goal('旅行基金');
  assert.equal(g.id, id);
  assert.equal(g.deposited_cents, 10000, '存入记录继续累计');
  assert.equal(t.rows('savings_goals').length, 1, '修改不新增行');
  assert.throws(() => t.saveGoal(goal({ id, target_date: '2026-04-01' })), /今天之后/);
});

test('存入：编号、金额、日期、目标的检查；被拒绝时什么都不写', () => {
  const t = savingsSetup();
  t.saveGoal(goal());
  const id = t.goal('旅行').id;
  assert.throws(() => t.deposit({ request_id: 'short', goal_id: id, amount: '5' }), /编号无效/);
  assert.throws(() => t.deposit({ request_id: 'bad id with spaces', goal_id: id, amount: '5' }), /编号无效/);
  assert.throws(() => t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '0' }), /大于 0/);
  assert.throws(() => t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '1.234' }), /存入金额/);
  assert.throws(() => t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '5', date_ny: '2026-05-16' }), /未来/);
  assert.throws(() => t.deposit({ request_id: 'req-00000001', goal_id: 'nope', amount: '5' }), /找不到这个储蓄目标/);
  assert.deepEqual(t.rows('savings_contributions'), []);
});

test('存入：同一编号重试只记一次；同一编号换了金额会被拒绝；日期默认今天，可以选过去的日期', () => {
  const t = savingsSetup();
  t.saveGoal(goal());
  const id = t.goal('旅行').id;
  t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '50' });
  t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '50' });
  assert.equal(t.rows('savings_contributions').length, 1);
  assert.throws(() => t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '60' }), /已记录/);
  t.deposit({ request_id: 'req-00000002', goal_id: id, amount: '25.5', date_ny: '2026-04-02' });
  const g = t.goal('旅行');
  assert.equal(g.deposited_cents, 7550);
  assert.deepEqual(g.contributions.map((c) => [c.date_ny, c.amount_cents]), [['2026-05-15', 5000], ['2026-04-02', 2550]], '新的在前');
});

test('存入：省略日期的同一请求跨过午夜重试，仍沿用第一次的日期，不会记两笔', () => {
  const t = savingsSetup('2026-05-16T03:50:00Z');   // 费城 5 月 15 日 23:50
  t.saveGoal(goal());
  const id = t.goal('旅行').id;
  t.deposit({ request_id: 'req-midnight', goal_id: id, amount: '10' });
  t.setNow('2026-05-16T04:10:00Z');                  // 费城 5 月 16 日 00:10
  t.deposit({ request_id: 'req-midnight', goal_id: id, amount: '10' });
  assert.deepEqual(t.rows('savings_contributions').map((c) => c.date_ny), ['2026-05-15']);
});

test('完成的目标：进度封顶 100%，不再占用月度储蓄安排；存入不进入日常账目和月报', () => {
  const t = savingsSetup();
  t.saveGoal(goal({ target_amount: '100', starting_saved_amount: '80', monthly_amount: '20' }));
  const id = t.goal('旅行').id;
  t.expense('30', '餐饮', '2026-05-10T12:00');
  const before = plain(t.report('2026-05'));
  t.deposit({ request_id: 'req-00000001', goal_id: id, amount: '50' });
  const g = t.goal('旅行');
  assert.equal(g.completed, true);
  assert.equal(g.saved_cents, 13000);
  assert.equal(g.remaining_cents, 0);
  assert.equal(g.progress_tenths, 1000, '超过目标也只显示 100%');
  assert.equal(g.monthly_cents, 2000, '原计划保留');
  assert.equal(g.effective_monthly_cents, 0);
  assert.equal(t.view().forecast.planned_savings_cents, 0);
  assert.equal(t.view().forecast.active_goal_count, 0);
  assert.equal(t.rows('entries').length, 1, '存入不会变成一笔账目');
  assert.deepEqual(plain(t.report('2026-05')), before, '月报不变');
  // 已完成：月存款可以留空（按 0）
  t.saveGoal(goal({ id, target_amount: '100', starting_saved_amount: '80', monthly_amount: '' }));
  assert.equal(t.goal('旅行').monthly_cents, 0);
});

test('本月估算：只能写当前月份；省略字段保留、清空恢复未知、0 是有效金额、负数被拒绝', () => {
  const t = savingsSetup();
  assert.throws(() => t.g.svcSaveSavingsEstimates(t.repo, { month: '2026-04', income_amount: '100' }, t.now()), /月份已经变化/);
  let v = t.estimate({ income_amount: '3000', expense_amount: '1000' });
  assert.deepEqual(v.estimates, { month: '2026-05', income_cents: 300000, expense_cents: 100000 });
  v = t.estimate({ income_amount: '3500' });
  assert.equal(v.estimates.expense_cents, 100000, '没有提交的字段保留原值');
  v = t.estimate({ expense_amount: '' });
  assert.equal(v.estimates.expense_cents, null, '清空 = 未知');
  v = t.estimate({ expense_amount: '0' });
  assert.equal(v.estimates.expense_cents, 0, '0 是有效估算，不等于未知');
  assert.throws(() => t.estimate({ income_amount: '-5' }), /预计月收入/);
  assert.equal(t.rows('savings_estimates').length, 1, '同一个月只有一行');
  // 到了 6 月：5 月的估算不再生效
  t.setNow('2026-06-02T16:00:00Z');
  assert.deepEqual(t.view().estimates, { month: '2026-06', income_cents: null, expense_cents: null });
});

test('月底估算：收入/支出用最近三个完整月的平均（只算有金额的月份），支出不低于本月已记；减去全部目标月存款', () => {
  const t = savingsSetup();
  // 2–4 月：收入只有 2、3 月；支出 3 个月都有
  t.income('3000', '工资', '2026-02-05T09:00');
  t.income('3000', '工资', '2026-03-05T09:00');
  t.expense('1000', '住房', '2026-02-01T09:00');
  t.expense('2000', '住房', '2026-03-01T09:00');
  t.expense('1500', '住房', '2026-04-01T09:00');
  t.autoPending('餐饮', '2026-04-20T12:00');            // 历史里金额未知的一笔
  t.expense('999', '餐饮', '2026-01-20T12:00');          // 1 月不在最近三个月内
  t.expense('400', '餐饮', '2026-05-03T12:00');          // 本月已记
  t.saveGoal(goal({ name: 'A', monthly_amount: '500' }));
  t.saveGoal(goal({ name: 'B', monthly_amount: '2000' }));
  let f = t.view().forecast;
  assert.equal(f.can_estimate, true);
  assert.equal(f.income.projected_cents, 300000);
  assert.equal(f.income.source, 'history');
  assert.deepEqual(f.income.history.months_used, ['2026-02', '2026-03']);
  assert.equal(f.expense.projected_cents, 150000);
  assert.equal(f.expense.actual_to_date_cents, 40000);
  assert.equal(f.planned_savings_cents, 250000);
  assert.equal(f.monthly_net_cents, 150000);
  assert.equal(f.monthly_savings_capacity_cents, 150000);
  assert.equal(f.month_end_available_cents, 0, '不显示负数');
  assert.equal(f.over_capacity, true);
  assert.equal(f.over_capacity_cents, 100000);
  assert.equal(f.incomplete, true);
  assert.equal(f.pending_count, 1);

  // 手动收入优先于历史
  t.estimate({ income_amount: '5000' });
  f = t.view().forecast;
  assert.equal(f.income.source, 'manual');
  assert.equal(f.month_end_available_cents, 100000, '5000 − 1500 − 2500');
  assert.equal(f.over_capacity, false);

  // 本月支出超过历史平均：取本月已记
  t.expense('1700', '购物', '2026-05-10T12:00');
  f = t.view().forecast;
  assert.equal(f.expense.projected_cents, 210000);
  assert.equal(f.month_end_available_cents, 40000);
});

test('月底估算：没有收入历史时需要手动收入；没有支出历史时才使用手动支出', () => {
  const t = savingsSetup();
  let f = t.view().forecast;
  assert.equal(f.can_estimate, false);
  assert.equal(f.needs_income_estimate, true);
  assert.equal(f.needs_expense_estimate, true);
  assert.equal(f.month_end_available_cents, null);
  t.estimate({ income_amount: '2000', expense_amount: '0' });
  f = t.view().forecast;
  assert.equal(f.can_estimate, true);
  assert.equal(f.expense.source, 'manual');
  assert.equal(f.month_end_available_cents, 200000, '手动支出 0 也算估算过');
  t.expense('800', '住房', '2026-04-01T09:00');
  f = t.view().forecast;
  assert.equal(f.expense.source, 'history', '有了完整月支出历史就不用手动支出');
  assert.equal(f.expense.projected_cents, 80000);
});

test('小猫储蓄提醒：目标月存款超过预计可存时提醒一次（金额不变不重复）；调整后提醒消失', () => {
  const t = savingsSetup();
  const run = () => t.g.svcRunAssistantRules(t.repo, t.now(), t.newId);
  const savingsMsgs = () => plain(t.g.svcGetAssistant(t.repo, t.now())).messages.filter((m) => m.skill_id === 'savings_affordability');
  t.estimate({ income_amount: '3000', expense_amount: '2500' });
  t.saveGoal(goal({ monthly_amount: '800' }));
  run();
  let msgs = savingsMsgs();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /可存 \$500\.00/);
  assert.match(msgs[0].text, /多出了 \$300\.00/);
  assert.equal(msgs[0].action, 'goto:savings');
  assert.doesNotMatch(msgs[0].text, /旅行/, '提醒里没有目标名称');
  assert.equal(run().added, 0, '金额没变不再提醒');

  t.saveGoal(goal({ id: t.goal('旅行').id, monthly_amount: '400' }));
  run();
  assert.deepEqual(savingsMsgs(), [], '能负担后旧提醒不再显示');
});
