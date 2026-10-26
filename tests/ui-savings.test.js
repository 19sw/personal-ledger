'use strict';
/**
 * 网页测试（储蓄，2026-10-23）：报表 → 储蓄。新建目标、记录存入（含失败重试）、填写本月预估、旧账本提示。
 * jsdom 打开真实页面，后端是真实服务器代码 + 假表格。数字均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');

async function openSavings(app) {
  app.w.HTMLElement.prototype.scrollIntoView = () => {};   // jsdom 没有 scrollIntoView
  app.nav('report');
  await app.until(() => app.$('#report-tabs'), '报表');
  app.click(app.$('#report-tabs [data-tab="savings"]'));
  await app.until(() => app.$('.savings-forecast'), '储蓄页');
}

function submit(app, formSel) {
  app.$(formSel).dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
}

const goalCard = (app, name) => app.$$('.savings-goal').find((el) => el.querySelector('h3').textContent === name);

test('储蓄页：没有目标和预估时显示空状态和缺少预估；新建目标后显示进度和预计达成月份', async () => {
  const app = await openApp();
  await openSavings(app);
  assert.match(app.text('#page-report'), /还没有储蓄目标/);
  assert.match(app.text('#page-report'), /还缺少月收入预估和月支出预估/);
  assert.ok(app.$('#report-tabs [data-tab="savings"]').classList.contains('on'));

  app.click(app.$('[data-act="savings-goal"]'));
  await app.until(() => app.$('#savings-goal-form'), '新建目标表单');
  app.set('#sg-name', '应急金');
  app.set('#sg-target', '1000');
  app.set('#sg-start', '250');
  app.set('#sg-monthly', '150');
  submit(app, '#savings-goal-form');
  await app.until(() => goalCard(app, '应急金'), '目标卡片');
  assert.equal(app.$('#savings-goal-form'), null, '保存后表单收起');
  const card = goalCard(app, '应急金');
  assert.match(card.textContent, /已存 \$250\.00 \/ \$1,000\.00/);
  assert.equal(card.querySelector('progress').getAttribute('value'), '250');
  assert.match(card.textContent, /还需约 5 个月/);
  assert.match(app.text('.savings-forecast'), /全部目标月度存款− \$150\.00/);
  const rows = app.backend.g.sheetRepo_(app.backend.ss).list('savings_goals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_cents, 100000);
  assert.deepEqual(app.errors, []);
});

test('储蓄页：服务器拒绝时在表单里显示原因，表单保留，可以改正后再保存', async () => {
  const app = await openApp();
  await openSavings(app);
  app.click(app.$('[data-act="savings-goal"]'));
  await app.until(() => app.$('#savings-goal-form'), '新建目标表单');
  app.set('#sg-name', '电脑');
  app.set('#sg-target', '800');
  app.set('#sg-start', '0');
  submit(app, '#savings-goal-form');   // 没有日期也没有月存款
  await app.until(() => !app.$('#savings-goal-form .savings-error').hidden, '错误提示');
  assert.match(app.text('#savings-goal-form .savings-error'), /请填写每月计划存入的金额/);
  assert.equal(app.$('#sg-name').value, '电脑', '填过的内容保留');
  assert.equal(app.$('#sg-name').disabled, false, '可以继续修改');
  app.set('#sg-monthly', '100');
  submit(app, '#savings-goal-form');
  await app.until(() => goalCard(app, '电脑'), '目标卡片');
});

test('储蓄页：记录存入后进度和存入记录更新；结果没收到时用同一编号重试，只记一笔', async () => {
  const app = await openApp();
  const { g, ss } = app.backend;
  g.api_saveSavingsGoal({ name: '旅行', target_amount: '500', starting_saved_amount: '0', monthly_amount: '100' });
  await openSavings(app);
  const goalId = g.sheetRepo_(ss).list('savings_goals')[0].id;

  // 第一次：服务器已保存，但网页没收到结果（例如网络断了）
  const real = g.api_recordSavingsContribution;
  let calls = 0;
  const ids = [];
  g.api_recordSavingsContribution = (input) => {
    calls++;
    ids.push(input.request_id);
    const res = real(input);
    if (calls === 1) throw new Error('网络中断');
    return res;
  };
  app.click(goalCard(app, '旅行').querySelector('[data-act="savings-deposit"]'));
  await app.until(() => app.$('#savings-deposit-form'), '存入表单');
  assert.equal(app.$('#sg-deposit-date').value, app.$('#sg-deposit-date').getAttribute('max'), '日期默认今天');
  app.set('#sg-deposit-amount', '120');
  submit(app, '#savings-deposit-form');
  await app.until(() => !app.$('#savings-deposit-form .savings-error').hidden, '失败提示');
  assert.match(app.text('#savings-deposit-form .savings-error'), /网络中断.*请重试确认同一笔存入/);
  assert.equal(app.$('#sg-deposit-amount').disabled, true, '重试时金额不能改');
  assert.match(app.text('#savings-deposit-form button[type="submit"]'), /重试确认这笔存入/);

  submit(app, '#savings-deposit-form');
  await app.until(() => !app.$('#savings-deposit-form') && /已存 \$120\.00/.test(goalCard(app, '旅行').textContent), '存入完成');
  assert.equal(calls, 2);
  assert.equal(ids[0], ids[1], '重试用同一个编号');
  const rows = g.sheetRepo_(ss).list('savings_contributions');
  assert.equal(rows.length, 1, '只记一笔');
  assert.equal(rows[0].goal_id, goalId);
  assert.equal(rows[0].amount_cents, 12000);
  assert.match(goalCard(app, '旅行').textContent, /存入记录（1 笔）/);
  assert.equal(g.sheetRepo_(ss).list('entries').length, 0, '存入不会变成日常账目');
});

test('储蓄页：填写本月预估后算出月底可用金额；超出可存时小猫提醒并能跳回储蓄页', async () => {
  const app = await openApp();
  const { g } = app.backend;
  g.api_saveSavingsGoal({ name: '旅行', target_amount: '5000', starting_saved_amount: '0', monthly_amount: '800' });
  await openSavings(app);
  assert.equal(app.$('#savings-estimates-form').closest('details').open, true, '缺少预估时自动展开');
  app.set('#sg-income', '3000');
  app.set('#sg-expense', '2000');
  submit(app, '#savings-estimates-form');
  await app.until(() => /\$200\.00/.test(app.text('.savings-big')), '月底可用金额');
  assert.doesNotMatch(app.text('.savings-forecast'), /还缺少/);
  const est = g.sheetRepo_(app.backend.ss).list('savings_estimates');
  assert.deepEqual(JSON.parse(JSON.stringify(est.map((r) => [r.month, r.income_cents, r.expense_cents]))), [[app.currentMonth(), 300000, 200000]]);

  // 月存款提高到 1500：超出可存 1000，小猫提醒
  const goalId = g.sheetRepo_(app.backend.ss).list('savings_goals')[0].id;
  g.api_saveSavingsGoal({ id: goalId, name: '旅行', target_amount: '5000', starting_saved_amount: '0', monthly_amount: '1500' });
  const msg = g.api_getAssistant().messages.find((m) => m.skill_id === 'savings_affordability');
  assert.ok(msg, '有储蓄提醒');
  assert.match(msg.text, /多出了 \$500\.00/);

  app.nav('entries');
  await app.until(() => !app.$('#page-entries').hidden, '账目页');
  app.click(app.$('#assistant-btn'));
  const go = await app.until(() => app.$('#aov-list [data-act="assistant-goto"][data-action="goto:savings"]'), '提醒里的按钮');
  app.$('#page-report').innerHTML = '';
  app.click(go);
  await app.until(() => !app.$('#page-report').hidden && app.$('.savings-forecast'), '跳回储蓄页');
  assert.match(app.text('.savings-big'), /\$0\.00/, '超出可存：月底可用按 0 显示');
  assert.deepEqual(app.errors, []);
});

test('储蓄页：旧账本还没有储蓄表时提示运行 setupLedger，按钮不可用', async () => {
  const app = await openApp({
    beforeOpen(backend) {
      for (const name of ['savings_goals', 'savings_contributions', 'savings_estimates']) {
        backend.ss.deleteSheet(backend.ss.getSheetByName(name));
      }
    }
  });
  await openSavings(app);
  assert.match(app.text('#page-report'), /储蓄功能还没有启用/);
  assert.equal(app.$('[data-act="savings-goal"]').disabled, true);
  assert.equal(app.$('#savings-estimates-form fieldset').disabled, true);
  assert.deepEqual(app.errors, []);
});
