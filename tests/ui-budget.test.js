'use strict';
/**
 * 网页测试（Task 05）：预算页、报表（月报圆环图 + 月账单 / 年账单）、我的 → 预算提醒比例。
 * jsdom 打开真实页面，后端是真实服务器代码 + 假表格。数字均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');

function helpers(app) {
  const { g, ss } = app.backend;
  const month = app.currentMonth();
  const prevMonth = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); })();
  return {
    g, ss, month, prevMonth,
    save: (type, amount, category_id, local, extra = {}) => g.api_saveEntry(Object.assign({ type, amount, category_id, local_datetime: local }, extra)),
    /** 用过去某一刻作为“现在”设置预算（模拟以前设过的预算） */
    setBudgetAt: (scope, amount, local) => g.svcSetBudget(g.sheetRepo_(ss), scope, amount, g.parseLocalNY(local), () => 'seed-' + Math.random()),
    pending: (category_id, local) => {
      const d = g.parseLocalNY(local);
      g.sheetRepo_(ss).insert('entries', { id: 'p-' + Math.random(), type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
        date_ny: g.dateNY(d), category_id, merchant: 'Apple Pay', channel: 'apple_pay', source_key: 'ap:' + Math.random(),
        created_at: d.toISOString(), updated_at: d.toISOString() });
    }
  };
}

async function openBudget(app) {
  app.nav('budget');
  await app.until(() => !app.$('#page-budget').hidden && app.$('#page-budget .monthnav'), '预算页');
}
const ringSeg = (app) => app.$('#budget-total .donut-seg');

test('预算页：没有总预算时显示空状态，用数字键盘设置后显示圆环（剩余 100%、薄荷绿）', async () => {
  const app = await openApp();
  await openBudget(app);
  assert.ok(app.$('#budget-empty'), '空状态');
  assert.match(app.text('#budget-empty'), /还没有设置总预算/);
  assert.match(app.text('#budget-cats'), /还没有类别预算/);
  app.click(app.$('#budget-empty [data-act="budget-edit"]'));
  await app.until(() => app.$('#budget-sheet:not([hidden]) #bs-keypad'), '预算键盘');
  assert.equal(app.text('#bs-amt'), '$0');
  assert.equal(app.$$('#budget-sheet input').length, 0, '不用手机键盘输入金额');
  app.click(app.$('[data-act="bs-save"]'));
  assert.match(app.text('#bs-hint'), /先填金额/, '空金额不能新建');
  for (const k of '1500') app.click(app.$(`[data-act="bkey"][data-key="${k}"]`));
  assert.equal(app.text('#bs-amt'), '$1500');
  app.click(app.$('[data-act="bs-save"]'));
  await app.until(() => app.$('#budget-total'), '总预算卡片');
  assert.ok(app.$('#budget-sheet').hidden, '保存后面板收起');
  assert.equal(app.$('#budget-total').dataset.state, 'ok');
  assert.equal(ringSeg(app).getAttribute('stroke'), '#5DCAA5');
  assert.equal(ringSeg(app).dataset.len, '1000');
  assert.match(app.text('#budget-total .ring-center'), /剩余100%/);
  assert.match(app.text('#budget-total'), /剩余预算\$1,500\.00/);
  assert.match(app.text('#budget-total'), /本月预算\$1,500\.00/);
  assert.match(app.text('#budget-total'), /本月支出\$0\.00/);
  assert.match(app.text('#budget-days'), /本月还剩 \d+ 天|今天是本月最后一天/);
  assert.deepEqual(app.errors, []);
});

test('预算圆环颜色：< 80% 薄荷绿，≥ 80% 橙色，超出红色并在中间显示“超出 $X”；提醒比例改为 90 后 85% 变回薄荷绿', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.g.api_setBudget('total', '100');
  h.save('expense', '79.99', 'exp_dining', h.month + '-01T12:00');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'ok', '79.99% 不算接近');
  assert.equal(ringSeg(app).getAttribute('stroke'), '#5DCAA5');
  assert.equal(ringSeg(app).dataset.len, '200', '剩余 20%（已用四舍五入为 80%）');

  h.save('expense', '0.01', 'exp_dining', h.month + '-01T12:05');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'near', '80% 接近');
  assert.equal(ringSeg(app).getAttribute('stroke'), '#EF9F27');
  assert.match(app.text('#budget-total .ring-center'), /剩余20%/);

  h.save('expense', '25', 'exp_shopping', h.month + '-01T12:10');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'over');
  assert.equal(ringSeg(app).getAttribute('stroke'), '#E24B4A');
  assert.equal(ringSeg(app).dataset.len, '1000', '超出时整圈红色');
  assert.match(app.text('#budget-total .ring-center'), /超出\$5\.00/);
  assert.match(app.text('#budget-total'), /超出预算\$5\.00/);

  // 回到 85%，再把提醒比例改为 90
  const del = h.g.api_listMonth(h.month).days[0].entries.find((e) => e.amount_cents === 2500);
  h.g.api_deleteEntry(del.id);
  h.save('expense', '5', 'exp_dining', h.month + '-01T12:20');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'near');
  await app.openMeSub('near');
  await app.until(() => app.$('#f-near-pct'), '我的');
  assert.equal(app.$('#f-near-pct').value, '80');
  assert.equal(app.$$('#f-near-pct option').length, 51, '50–100');
  app.set('#f-near-pct', '90');
  await app.until(() => app.text('#toast').includes('90%'), '保存比例');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'ok');
  assert.deepEqual(app.errors, []);
});

test('预算圆环：正常时有加载动画，“减少动态效果”时没有', async () => {
  const still = await openApp();
  still.backend.g.api_setBudget('total', '100');
  await openBudget(still);
  assert.ok(!ringSeg(still).classList.contains('anim'));
  const moving = await openApp({ reducedMotion: false });
  moving.backend.g.api_setBudget('total', '100');
  await openBudget(moving);
  assert.ok(ringSeg(moving).classList.contains('anim'));
});

test('类别预算：添加（选择里没有“未分类”和已有预算的类别）→ 细条显示 → 点行修改 → 清空后完成 = 取消', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.g.api_setBudget('total', '1000');
  h.save('expense', '170', 'exp_dining', h.month + '-01T12:00');
  await openBudget(app);
  app.click(app.$('[data-act="budget-add"]'));
  await app.until(() => app.$('#bs-grid'), '类别选择');
  const names = app.$$('#bs-grid .tile .nm').map((n) => n.textContent);
  assert.ok(names.includes('餐饮'));
  assert.ok(!names.includes('未分类'), '未分类不显示');
  assert.ok(!app.$$('#bs-grid .tile').some((t) => t.dataset.id === 'exp_uncategorized'));
  app.click(app.$$('#bs-grid .tile').find((t) => t.querySelector('.nm').textContent === '餐饮'));
  await app.until(() => app.$('#bs-keypad'), '键盘');
  for (const k of '200') app.click(app.$(`[data-act="bkey"][data-key="${k}"]`));
  app.click(app.$('[data-act="bs-save"]'));
  await app.until(() => app.$('#budget-cats .brow'), '类别行');
  const row = app.$('#budget-cats .brow');
  assert.equal(row.tagName, 'BUTTON');
  assert.equal(row.dataset.state, 'near', '85% → 橙色');
  assert.match(row.textContent, /餐饮\$170\.00 \/ \$200\.00/);
  assert.equal(row.querySelector('.thinbar span').style.width, '85%');
  assert.equal(row.querySelector('.thinbar span').style.background.replace(/\s/g, ''), 'rgb(239,159,39)');

  // 再次添加时，餐饮不在可选列表里
  app.click(app.$('[data-act="budget-add"]'));
  await app.until(() => app.$('#bs-grid'), '类别选择');
  assert.ok(!app.$$('#bs-grid .tile .nm').map((n) => n.textContent).includes('餐饮'));
  app.click(app.$('#budget-sheet [data-act="bs-close"]'));

  // 修改为 150 → 超出 $20.00
  app.click(app.$('#budget-cats .brow'));
  await app.until(() => app.$('#bs-keypad'), '键盘');
  assert.equal(app.text('#bs-amt'), '$200', '带出当前金额');
  app.click(app.$('[data-act="bkey"][data-key="clear"]'));
  for (const k of '150') app.click(app.$(`[data-act="bkey"][data-key="${k}"]`));
  app.click(app.$('[data-act="bs-save"]'));
  await app.until(() => app.$('#budget-cats .brow[data-state="over"]'), '超出');
  assert.match(app.text('#budget-cats .bover'), /超出 \$20\.00/);
  assert.equal(app.$('#budget-cats .thinbar span').style.width, '100%');

  // 清空后点完成 = 从本月起取消
  app.click(app.$('#budget-cats .brow'));
  await app.until(() => app.$('#bs-keypad'), '键盘');
  app.click(app.$('[data-act="bkey"][data-key="clear"]'));
  app.click(app.$('[data-act="bs-save"]'));
  await app.until(() => !app.$('#budget-cats .brow'), '已取消');
  assert.match(app.text('#toast'), /已取消预算/);
  const rows = h.g.sheetRepo_(h.ss).list('budgets').filter((r) => r.scope === 'exp_dining');
  assert.equal(rows.length, 1, '同月：更新本月那一行，不追加');
  assert.equal(rows[0].amount_cents, null);
  assert.deepEqual(app.errors, []);
});

test('类别预算：“取消这项预算”按钮；D10 提示；待补全附注', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.g.api_setBudget('total', '100');
  h.g.api_setBudget('exp_dining', '80');
  h.g.api_setBudget('exp_shopping', '50');
  h.pending('exp_dining', h.month + '-01T10:00');
  await openBudget(app);
  assert.match(app.text('#budget-warning'), /类别预算合计 \$130\.00，高于总预算 \$100\.00/);
  assert.match(app.text('#budget-pending'), /有 1 笔未补全，预算统计不完整/);
  app.click(app.$$('#budget-cats .brow').find((r) => r.textContent.includes('购物')));
  await app.until(() => app.$('[data-act="bs-cancel-budget"]'), '取消按钮');
  app.click(app.$('[data-act="bs-cancel-budget"]'));
  await app.until(() => app.$$('#budget-cats .brow').length === 1, '取消购物预算');
  assert.ok(!app.$('#budget-warning'), '合计不再高于总预算');
  assert.deepEqual(app.errors, []);
});

test('预算页：过去月份只读（显示当时的预算，没有修改/添加）；不能翻到以后的月份', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.setBudgetAt('total', '500', h.prevMonth + '-15T12:00');
  h.setBudgetAt('exp_dining', '100', h.prevMonth + '-15T12:00');
  h.g.api_setBudget('total', '800');   // 本月改为 800：上个月仍是 500
  await openBudget(app);
  assert.ok(app.$('[data-act="bnext"]').disabled, '当前月不能往后翻');
  assert.ok(app.$('#budget-total [data-act="budget-edit"]'));
  assert.match(app.text('#budget-total'), /本月预算\$800\.00/);
  app.click(app.$('[data-act="bprev"]'));
  await app.until(() => app.$('#budget-readonly'), '上个月');
  assert.match(app.text('#budget-readonly'), /只能查看/);
  assert.match(app.text('#budget-total'), /\$500\.00/);
  assert.ok(!app.$('#page-budget [data-act="budget-edit"]'), '没有修改');
  assert.ok(!app.$('#page-budget [data-act="budget-add"]'), '没有添加');
  assert.equal(app.$('#budget-cats .brow').tagName, 'DIV', '类别行不可点');
  assert.equal(app.$('#budget-days'), null, '过去月份不显示剩余天数');
  assert.deepEqual(app.errors, []);
});

test('预算页：账本还没有 budgets / settings 表时提示运行 setupLedger，不出错、不能修改', async () => {
  const app = await openApp();
  delete app.backend.ss.sheets.budgets;
  delete app.backend.ss.sheets.settings;
  await openBudget(app);
  assert.match(app.text('#budget-setup'), /setupLedger/);
  assert.ok(app.$('#budget-empty'));
  assert.ok(!app.$('#page-budget [data-act="budget-edit"]'));
  app.nav('report');
  await app.until(() => app.$('#report-expense'), '月报');
  await app.openMeSub('near');
  await app.until(() => app.$('#f-near-pct'), '我的');
  app.set('#f-near-pct', '90');
  await app.until(() => app.text('#toast').includes('setupLedger'), '提示');
  assert.equal(app.$('#f-near-pct').value, '80', '失败后恢复原值');
  assert.equal(app.backend.ss.getSheetByName('budgets'), null);
  assert.deepEqual(app.errors, []);
});

test('月报圆环：PRD 第 7 节数字（60.0%/40.0%，A 600 / B 400，收入 1,000 / 支出 200 / 结余 800），图例合计与切片', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.save('expense', '120', 'exp_dining', h.month + '-01T12:00');
  h.save('expense', '80', 'exp_shopping', h.month + '-01T13:00');
  h.save('income', '600', 'inc_parttime', h.month + '-01T09:00', { new_source_name: '兼职 A' });
  h.save('income', '400', 'inc_parttime', h.month + '-01T10:00', { new_source_name: '兼职 B' });
  app.nav('report');
  await app.until(() => app.$('[data-act="rnext"]'), '月报');
  app.click(app.$('[data-act="rnext"]'));
  await app.until(() => app.text('#page-report').includes('本月进行中'), '本月月报');
  assert.equal(app.$$('#page-report .bar').length, 0, '不再有柱状图');
  const exp = app.$('#report-expense');
  assert.match(exp.querySelector('.ring-center').textContent, /总支出\$200\.00/);
  assert.deepEqual(app.$$('#report-expense .lg-row').map((r) => r.textContent), ['餐饮$120.00 · 60.0%', '购物$80.00 · 40.0%']);
  const segs = app.$$('#report-expense .donut-seg').map((s) => [s.getAttribute('stroke'), +s.dataset.len, +s.getAttribute('stroke-dashoffset')]);
  assert.deepEqual(segs, [['#5DCAA5', 600, 0], ['#F0997B', 400, -600]]);
  assert.match(app.$('#report-expense svg').getAttribute('aria-label'), /餐饮 \$120\.00 60\.0%/);

  assert.match(app.text('#report-income .ring-center'), /总收入\$1,000\.00/);
  assert.match(app.text('#report-income'), /兼职\$1,000\.00 · 100\.0%/);
  assert.match(app.text('#report-income .sources'), /兼职 A\$600\.00 · 60\.0%/);
  assert.match(app.text('#report-income .sources'), /兼职 B\$400\.00 · 40\.0%/);
  assert.equal(app.$$('#report-income .donut-seg').length, 1);
  assert.equal(app.$('#report-income .donut-seg').dataset.len, '1000');
  app.click(app.$('#report-income [data-act="toggle-sources"]'));
  assert.ok(!app.$('#report-income .sources').hidden, '展开来源');

  assert.equal(app.text('#diff'), '$800.00');
  assert.match(app.text('#report-compare'), /收入\$1,000\.00/);
  assert.match(app.text('#report-compare'), /支出\$200\.00/);
  const cmp = app.$$('#report-compare .donut-seg').map((s) => +s.dataset.len);
  assert.deepEqual(cmp, [833, 167], '两段圆环：收入 1000 : 支出 200');
  assert.equal(app.$('#report-budget'), null, '没有预算时不显示预算小结');
  assert.deepEqual(app.errors, []);
});

test('圆环切片函数：前 6 项各一种颜色，其余合并为灰色；净退款不画；长度合计正好 1000', async () => {
  const app = await openApp();
  const f = app.w.__app.donutSlices;
  const rows = [700, 500, 300, 200, 100, 90, 60, 50, -30].map((c, i) => ({ name: 'c' + i, cents: c }));
  const r = JSON.parse(JSON.stringify(f(rows)));
  assert.deepEqual(r.colors, ['#5DCAA5', '#F0997B', '#ED93B1', '#FAC775', '#AFA9EC', '#85B7EB', '#B4B2A9', '#B4B2A9', null]);
  assert.equal(r.slices.length, 7);
  assert.equal(r.slices[6].name, '其余 2 项');
  assert.equal(r.slices.reduce((a, s) => a + s.len, 0), 1000);
  r.slices.forEach((s, i) => { if (i) assert.equal(s.start, r.slices[i - 1].start + r.slices[i - 1].len); });
  assert.deepEqual(JSON.parse(JSON.stringify(f([{ name: 'x', cents: -100 }]))).slices, [], '只有退款：空圆环');
  const third = JSON.parse(JSON.stringify(f([1, 1, 1].map((c) => ({ name: 'a', cents: c })))));
  assert.deepEqual(third.slices.map((s) => s.len), [333, 333, 334]);
});

test('月报预算小结：一句白话 + 每项已用/剩余或超出', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.g.api_setBudget('total', '1000');
  h.g.api_setBudget('exp_dining', '150');
  h.save('expense', '170', 'exp_dining', h.month + '-01T12:00');
  app.nav('report');
  await app.until(() => app.$('[data-act="rnext"]'), '月报');
  app.click(app.$('[data-act="rnext"]'));
  await app.until(() => app.$('#report-budget'), '预算小结');
  assert.match(app.text('#report-budget h2'), /本月预算小结/);
  assert.match(app.text('#report-budget .bsum'), /总预算剩余 \$830\.00，餐饮超出 \$20\.00。/);
  assert.match(app.text('#report-budget'), /超出 \$20\.00/);
  assert.ok(app.$('#report-budget .neg'));
  assert.deepEqual(app.errors, []);
});

test('账单：月账单 → 点某个月进入那个月的月报；年账单 → 点某一年进入那一年的月账单；脚注与不完整提示', async () => {
  const app = await openApp();
  const h = helpers(app);
  const year = h.month.slice(0, 4);
  const last = String(+year - 1);
  h.save('income', '3000', 'inc_salary', last + '-03-10T09:00');
  h.save('expense', '3500', 'exp_housing', last + '-04-01T09:00');   // 去年 4 月结余为负
  h.save('expense', '120', 'exp_dining', h.month + '-01T12:00');
  h.pending('exp_dining', h.month + '-01T13:00');
  app.nav('report');
  await app.until(() => app.$('#report-tabs'), '报表');
  app.click(app.$('#report-tabs [data-tab="bills"]'));
  await app.until(() => app.$('#bill-hero'), '月账单');
  assert.match(app.text('#page-report .monthnav'), new RegExp(year + ' 年'));
  assert.ok(app.$('[data-act="ynext"]').disabled, '今年不能往后翻');
  const rows = app.$$('.bt-row');
  assert.equal(rows.length, 1, '今年第一笔账在本月：只列本月（之前的空月份不列）');
  assert.equal(rows[0].dataset.month, h.month, '新的月份在前');
  assert.match(app.text('#bill-hero'), /年结余-\$120\.00/);
  assert.match(app.text('#bill-hero'), /年支出\$120\.00/);
  assert.match(app.text('#bills-incomplete'), /有 1 笔金额未补全/);
  assert.match(app.text('#bills-footnote'), /年账单为自然年（1\.1–12\.31），按费城时间/);

  // 点本月 → 本月月报
  app.click(rows[0]);
  await app.until(() => app.$('#report-expense'), '月报');
  assert.equal(app.w.__app.state.reportMonth, h.month);
  assert.ok(app.$('#report-tabs [data-tab="month"]').classList.contains('on'));
  assert.match(app.text('#report-expense .ring-center'), /\$120\.00/);

  // 年账单
  app.click(app.$('#report-tabs [data-tab="bills"]'));
  await app.until(() => app.$('#bills-tabs'), '账单');
  app.click(app.$('#bills-tabs [data-tab="year"]'));
  await app.until(() => app.$('[data-act="bill-year"]'), '年账单');
  assert.deepEqual(app.$$('[data-act="bill-year"]').map((r) => r.dataset.year), [year, last]);
  assert.match(app.text('#bill-hero'), /总结余-\$620\.00/);
  assert.match(app.text('#bill-hero'), /总收入\$3,000\.00/);
  assert.match(app.text('#bill-hero'), /总支出\$3,620\.00/);
  app.click(app.$(`[data-act="bill-year"][data-year="${last}"]`));
  await app.until(() => app.$$('.bt-row[data-month]').length === 10, '去年的月账单（3 月起）');
  assert.equal(app.$(`.bt-row[data-month="${last}-02"]`), null, '去年 3 月之前没有账目，不列');
  assert.match(app.text('#page-report .monthnav'), new RegExp(last + ' 年'));
  const apr = app.$(`.bt-row[data-month="${last}-04"]`);
  assert.ok(apr.querySelector('.neg'), '结余为负显示红色');
  assert.match(app.text('#bill-hero'), /年结余-\$500\.00/);
  assert.equal(app.$('#bills-incomplete'), null, '去年没有待补全');
  app.click(app.$(`.bt-row[data-month="${last}-03"]`));
  await app.until(() => app.$('#report-income'), '去年 3 月月报');
  assert.equal(app.w.__app.state.reportMonth, last + '-03');
  assert.match(app.text('#report-income .ring-center'), /\$3,000\.00/);
  assert.deepEqual(app.errors, []);
});

test('收支对比圆环：结余为负时中间金额显示红色（neg 类）', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.save('expense', '50', 'exp_dining', h.month + '-01T12:00');
  app.nav('report');
  await app.until(() => app.$('[data-act="rnext"]'), '月报');
  app.click(app.$('[data-act="rnext"]'));
  await app.until(() => app.text('#page-report').includes('本月进行中'), '本月月报');
  assert.equal(app.text('#diff'), '-$50.00');
  assert.ok(app.$('#diff').classList.contains('neg'));
  const css = require('fs').readFileSync(require('path').join(__dirname, '../apps/main/ui/style.html'), 'utf8');
  assert.match(css, /\.ring-center strong\.neg\s*\{\s*color:\s*var\(--danger\)/, '比 .ring-center strong 更具体的红色规则');
  assert.deepEqual(app.errors, []);
});

test('预算圆环：恰好用满 100% 时仍有最小橙色弧，中间百分比用状态色；超出时整圈无接缝', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.g.api_setBudget('total', '100');
  h.save('expense', '100', 'exp_dining', h.month + '-01T12:00');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'near');
  assert.match(app.text('#budget-total .ring-center'), /剩余0%/);
  assert.equal(ringSeg(app).getAttribute('stroke'), '#EF9F27');
  assert.equal(+ringSeg(app).dataset.len, 20, '最小可见弧 2%');
  assert.ok(app.$('#budget-total .ring-center strong').classList.contains('near'), '中间文字用橙色');

  h.save('expense', '5', 'exp_dining', h.month + '-01T12:05');
  await openBudget(app);
  assert.equal(app.$('#budget-total').dataset.state, 'over');
  const seg = ringSeg(app);
  assert.equal(seg.dataset.len, '1000');
  assert.ok(seg.classList.contains('full'));
  assert.equal(seg.getAttribute('stroke-dasharray'), null, '整圈不带 dasharray，避免 12 点接缝');
  assert.ok(app.$('#budget-total .ring-center strong').classList.contains('over'));
  assert.deepEqual(app.errors, []);
});

test('预算页：过去月份没有总预算时空状态写“N 月支出”，本月写“本月支出”', async () => {
  const app = await openApp();
  const h = helpers(app);
  h.save('expense', '30', 'exp_dining', h.prevMonth + '-10T12:00');
  await openBudget(app);
  assert.match(app.text('#budget-empty'), /还没有设置总预算/);
  app.click(app.$('[data-act="bprev"]'));
  await app.until(() => app.$('#budget-readonly'), '上个月');
  const m = +h.prevMonth.slice(5, 7);
  assert.match(app.text('#budget-empty'), new RegExp('（' + m + ' 月支出 \\$30\\.00）'));
  assert.ok(!app.text('#budget-empty').includes('本月支出'));
  assert.deepEqual(app.errors, []);
});
