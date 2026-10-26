'use strict';
/**
 * 网页冒烟测试：在 jsdom（模拟浏览器）里打开真实的 ui/index.html，像用户一样点击，
 * 后端是 tests/helpers/harness.js 中运行的真实服务器代码（Google 服务为模拟）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');


test('网页：空状态 → 记两笔支出 → 列表与本月月报（60.0% / 40.0%）', async () => {
  const app = await openApp();
  assert.match(app.text('#page-entries'), /本月还没有记录/);
  await app.addEntry({ amount: '120', category: '餐饮', day: '05' });
  await app.addEntry({ amount: '80', category: '购物', day: '06' });
  const entries = app.$$('#page-entries .entry');
  assert.equal(entries.length, 2);
  assert.match(entries[0].textContent, /购物/);
  assert.match(entries[0].textContent, /\$80\.00/);
  assert.match(entries[0].textContent, /手动/);

  app.nav('report');
  await app.until(() => app.$('#page-report .monthnav'), '月报');
  app.click(app.$('[data-act="rnext"]')); // 默认是上个月，切到本月
  await app.until(() => app.text('#page-report').includes('本月进行中'), '本月月报');
  const t = app.text('#page-report');
  assert.match(t, /\$200\.00/);
  assert.match(t, /餐饮\$120\.00 · 60\.0%/);
  assert.match(t, /购物\$80\.00 · 40\.0%/);
  assert.deepEqual(app.errors, []);
});

test('网页：收入来源分层、收支对比差额', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '120', category: '餐饮' });
  await app.addEntry({ amount: '80', category: '购物' });
  await app.addEntry({ type: 'income', amount: '600', category: '兼职', source: '兼职 A' });
  await app.addEntry({ type: 'income', amount: '400', category: '兼职', source: '兼职 B' });
  app.nav('report');
  await app.until(() => app.$('[data-act="rnext"]'), '月报');
  app.click(app.$('[data-act="rnext"]'));
  await app.until(() => app.text('#page-report').includes('收支对比') && app.text('#page-report').includes('本月进行中'), '本月月报');
  const t = app.text('#page-report');
  assert.match(t, /兼职\$1,000\.00 · 100\.0%/);
  assert.match(t, /兼职 A\$600\.00 · 60\.0%/);
  assert.match(t, /兼职 B\$400\.00 · 40\.0%/);
  assert.equal(app.text('#diff'), '$800.00');
  assert.ok(!app.$('#diff').classList.contains('neg'));
  assert.deepEqual(app.errors, []);
});

test('网页：待补全显示“—”与提示，补填后提示消失；删除与恢复', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '120', category: '餐饮' });
  // 模拟一笔金额未知的自动记录（自动入口在后续切片实现）
  const { g, ss } = app.backend;
  const repo = g.sheetRepo_(ss);
  const now = new Date();
  const local = app.currentMonth() + '-07T09:00';
  const d = g.parseLocalNY(local);
  repo.insert('entries', { id: 'auto-1', type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
    date_ny: g.dateNY(d), category_id: 'exp_uncategorized', merchant: 'Apple Pay', channel: 'apple_pay',
    source_key: 'applepay:evt:t1', created_at: now.toISOString(), updated_at: now.toISOString() });
  app.nav('entries');
  await app.until(() => app.text('#page-entries').includes('笔待补全'), '提示条');
  assert.match(app.text('.banner'), /本月有 1 笔待补全、0 笔待核对/);
  const pendingRow = app.$('#page-entries [data-id="auto-1"]');
  assert.match(pendingRow.textContent, /—/);
  assert.match(pendingRow.textContent, /无法识别金额，需要用户自行查看/);
  assert.match(pendingRow.textContent, /Apple Pay/);

  // 点提示条只看待处理的记录
  app.click(app.$('.banner'));
  await app.until(() => app.$$('#page-entries .entry').length === 1, '筛选');

  // 补填 50：自动记录的面板金额为空，带“无法识别金额”提示，收支类型不可改
  await app.openEdit('auto-1');
  assert.match(app.text('#entry-sheet'), /自动记录，渠道不可修改/);
  assert.match(app.text('#sheet-warn'), /无法识别金额/);
  assert.equal(app.text('#sheet-amt'), '$0');
  assert.ok(app.$('[data-act="tab"][data-type="income"]').disabled, '自动记录不能改成收入');
  assert.ok(!app.chipNames().includes('refund'), '自动记录的普通支出没有退款标签');
  app.keys('50');
  await app.saveAndWait();
  await app.until(() => !app.$('.banner'), '提示条消失');

  // 删除 → 最近删除 → 恢复
  await app.openEdit('auto-1');
  app.click(app.$('#sheet-actions [data-act="delete"]'));
  await app.until(() => app.text('#toast').includes('已删除'), '删除');
  await app.until(() => !app.$('#page-entries [data-id="auto-1"]') && app.$$('#page-entries .entry').length === 1, '列表更新');
  await app.openMeSub('deleted');
  await app.until(() => app.text('#page-settings').includes('自动清除'), '最近删除');
  app.click(app.$('#page-settings [data-act="restore"]'));
  await app.until(() => app.text('#toast').includes('已恢复'), '恢复');
  await app.until(() => app.$('#page-entries [data-id="auto-1"]'), '回到列表');
  assert.deepEqual(app.errors, []);
});

test('账目列表：自动交易的分类位置显示渠道标签，手动交易仍显示消费类别', async () => {
  const app = await openApp();
  const { g, ss } = app.backend;
  const repo = g.sheetRepo_(ss);
  const month = app.currentMonth();
  const now = new Date().toISOString();
  const appleAt = g.parseLocalNY(month + '-08T09:00');
  const gmailAt = g.parseLocalNY(month + '-09T09:00');
  repo.insert('entries', { id: 'label-apple', type: 'expense', amount_cents: 724, occurred_at: appleAt.toISOString(),
    month_ny: g.monthNY(appleAt), date_ny: g.dateNY(appleAt), category_id: 'exp_uncategorized', merchant: '茶店', channel: 'apple_pay',
    source_key: 'applepay:evt:label-test', created_at: now, updated_at: now });
  repo.insert('entries', { id: 'label-gmail', type: 'expense', amount_cents: 500, occurred_at: gmailAt.toISOString(),
    month_ny: g.monthNY(gmailAt), date_ny: g.dateNY(gmailAt), category_id: 'exp_uncategorized', merchant: '网店', channel: 'gmail_receipt', platform: 'doordash',
    source_key: 'gmail:label-test', created_at: now, updated_at: now });
  await app.addEntry({ amount: '10', category: '餐饮', day: '10', merchant: '午饭' });
  app.nav('entries');
  await app.until(() => app.$('[data-id="label-apple"]'), 'Apple Pay 行');
  const appleSub = app.$('[data-id="label-apple"] .sub').textContent;
  const gmailSub = app.$('[data-id="label-gmail"] .sub').textContent;
  const manualRow = app.$$('.entry').find((el) => el.textContent.includes('午饭'));
  assert.match(appleSub, /Apple Pay/);
  assert.doesNotMatch(appleSub, /未分类/);
  assert.match(gmailSub, /Online Order/);
  assert.match(gmailSub, /Gmail/ , '原有渠道信息仍可见');
  assert.match(manualRow.querySelector('.sub').textContent, /餐饮/);
  assert.deepEqual(app.errors, []);
});

test('网页：退款关联原交易，类别自动带出；设置页“未分类”不可删除', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '120', category: '餐饮', day: '03' });
  await app.openGrid();
  await app.pick('购物');
  app.chip('refund');
  await app.until(() => app.$('#f-refund-of'), '退款选择');
  assert.match(app.text('#chips'), /这是退款|退款/);
  const opt = app.$$('#f-refund-of option').find((o) => o.textContent.includes('$120.00'));
  app.set('#f-refund-of', opt.value);
  assert.equal(app.text('#sheet-cat'), '餐饮', '类别默认与原交易相同');
  assert.match(app.text('#chips'), /退款：餐饮 \$120\.00/, '标签显示关联的原交易');
  app.keys('20');
  app.chip('date');
  await app.until(() => app.$('#f-datetime'), '日期');
  app.set('#f-datetime', app.currentMonth() + '-04T12:00');
  await app.saveAndWait();
  assert.equal(app.$$('#page-entries .entry').length, 2);
  assert.match(app.text('#page-entries'), /-\$20\.00/);
  assert.match(app.text('#page-entries'), /退款/);

  await app.openMeSub('cats');
  await app.until(() => app.text('#page-settings').includes('支出类别'), '设置');
  const uncategorized = app.$$('#page-settings .list-item').find((li) => li.textContent.startsWith('未分类'));
  assert.match(uncategorized.textContent, /系统类别/);
  assert.equal(uncategorized.querySelector('[data-act="del-cat"]'), null);
  // 错误提示：重复类别
  app.$('#new-cat-expense').value = '餐饮';
  app.click(app.$('[data-act="add-cat"][data-type="expense"]'));
  await app.until(() => app.text('#toast').includes('已有同名类别'), '错误提示');
  assert.deepEqual(app.errors, []);
});

test('网页：底部导航恰好 5 项（账目/报表/记一笔/预算/我的），记一笔居中；我的打开设置页，报表页标题为“报表”', async () => {
  const app = await openApp();
  const items = app.$$('.bottomnav [data-nav]');
  assert.deepEqual(items.map((b) => b.getAttribute('data-nav')), ['entries', 'report', 'form', 'budget', 'settings']);
  assert.deepEqual(items.map((b) => b.textContent.trim()), ['账目', '报表', '记一笔', '预算', '我的']);
  assert.ok(items[2].classList.contains('navadd'), '记一笔是居中凸起按钮');
  await app.openMe();
  assert.equal(app.text('#page-title'), '我的');
  assert.ok(items[4].classList.contains('active'));
  app.nav('report');
  await app.until(() => app.$('#page-report .monthnav'), '报表');
  assert.equal(app.text('#page-title'), '报表');
  app.nav('budget');
  await app.until(() => app.$('#page-budget .monthnav'), '预算');
  assert.equal(app.text('#page-title'), '预算');
  assert.ok(items[3].classList.contains('active'));
  assert.deepEqual(app.errors, []);
});

test('网页：汇总卡片 支出/收入/结余，待补全显示“统计不完整”，且不受只看待处理筛选影响', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '120', category: '餐饮', day: '05' });
  await app.addEntry({ amount: '30', category: '购物', day: '06' });
  await app.addEntry({ type: 'income', amount: '600', category: '兼职', source: '兼职 A' });
  app.nav('entries');
  await app.until(() => app.$('#sum-expense'), '汇总卡片');
  assert.equal(app.text('#sum-expense'), '$150.00');
  assert.equal(app.text('#sum-income'), '$600.00');
  assert.equal(app.text('#sum-diff'), '$450.00');
  assert.equal(app.$('#sum-incomplete'), null);

  const { g, ss } = app.backend;
  const d = g.parseLocalNY(app.currentMonth() + '-07T09:00');
  g.sheetRepo_(ss).insert('entries', { id: 'auto-1', type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
    date_ny: g.dateNY(d), category_id: 'exp_uncategorized', merchant: 'Apple Pay', channel: 'apple_pay',
    source_key: 'applepay:evt:t1', created_at: d.toISOString(), updated_at: d.toISOString() });
  app.nav('entries');
  await app.until(() => app.$('#sum-incomplete'), '统计不完整');
  assert.match(app.text('#sum-incomplete'), /统计不完整/);
  assert.equal(app.text('#sum-expense'), '$150.00', '待补全不计入金额');

  app.click(app.$('.banner')); // 只看待处理：列表只剩 1 笔，但汇总仍是整月
  await app.until(() => app.$$('#page-entries .entry').length === 1, '筛选');
  assert.equal(app.text('#sum-expense'), '$150.00');
  assert.equal(app.text('#sum-income'), '$600.00');
  assert.equal(app.text('#sum-diff'), '$450.00');
  assert.deepEqual(app.errors, []);
});

test('网页：每笔账目有类别图标；用户自建的类别显示首字；日期分组是圆角卡片', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '12', category: '餐饮' });
  await app.openMeSub('cats');
  await app.until(() => app.$('#new-cat-expense'), '设置');
  app.set('#new-cat-expense', '健身房');
  app.click(app.$('[data-act="add-cat"][data-type="expense"]'));
  await app.until(() => app.text('#toast').includes('已添加'), '添加类别');
  await app.addEntry({ amount: '8', category: '健身房', day: '06' });
  assert.equal(app.$$('#page-entries .daycard').length, 2);
  const rows = app.$$('#page-entries .entry');
  assert.ok(rows.find((r) => r.textContent.includes('餐饮')).querySelector('.ci svg'), '默认类别用 SVG 图标');
  const custom = rows.find((r) => r.textContent.includes('健身房')).querySelector('.ci');
  assert.equal(custom.querySelector('svg'), null);
  assert.equal(custom.textContent, '健');
});

test('网页：所有默认类别（支出+收入）在网格里都有自己的 SVG 图标，且图标各不相同（同名“其他”除外）', async () => {
  const app = await openApp();
  await app.openGrid();
  const seen = new Map();
  for (const type of ['expense', 'income']) {
    app.click(app.$(`[data-act="tab"][data-type="${type}"]`));
    await app.until(() => app.$('#grid-tabs .on').dataset.type === type, '切换标签');
    for (const t of app.$$('#catgrid .tile:not(.add)')) {
      const name = t.querySelector('.nm').textContent;
      const svg = t.querySelector('.ic svg');
      assert.ok(svg, name + ' 有 SVG 图标');
      const key = svg.innerHTML;
      if (seen.has(key)) assert.equal(name, seen.get(key), name + ' 的图标与 ' + seen.get(key) + ' 重复');
      seen.set(key, name);
    }
  }
  assert.ok(seen.size >= 30);
});

test('网页：保存失败时按钮恢复、显示错误、金额/备注/标签内容保留，之后可再次保存', async () => {
  const app = await openApp({ reducedMotion: false });
  await app.openGrid();
  await app.pick('餐饮');
  app.keys('33.5');
  app.chip('merchant');
  app.type('#f-merchant', '咖啡店');
  app.type('#f-note', '备注一下');
  const realSave = app.backend.g.api_saveEntry;
  app.backend.g.api_saveEntry = () => { throw new Error('没保存成功，再试一次'); };
  const btn = app.$('[data-act="save"]');
  app.click(btn);
  assert.ok(btn.classList.contains('shrunk'), '点击后缩成圆形');
  await app.until(() => app.text('#toast').includes('没保存成功，再试一次'), '错误提示');
  assert.ok(!btn.classList.contains('shrunk') && !btn.classList.contains('saving'), '按钮恢复原样');
  assert.ok(btn.classList.contains('shake'), '失败时抖动');
  assert.equal(app.text('#sheet-amt'), '$33.5');
  assert.equal(app.$('#f-merchant').value, '咖啡店');
  assert.equal(app.$('#f-note').value, '备注一下');
  assert.match(app.text('#chips'), /商家：咖啡店/);
  assert.ok(app.$('#entry-sheet.open'), '面板仍然打开');
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('entries').length, 0);
  // 恢复后可以重新保存
  app.backend.g.api_saveEntry = realSave;
  app.click(app.$('[data-act="save"]'));
  await app.until(() => !app.$('#page-entries').hidden && app.$('#page-entries .entry'), '保存成功回到列表');
  const saved = app.backend.g.sheetRepo_(app.backend.ss).list('entries');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amount_cents, 3350);
  assert.equal(saved[0].merchant, '咖啡店');
  assert.equal(saved[0].note, '备注一下');
});

test('网页：连续点两次保存只发送一次保存请求', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  app.keys('9');
  let calls = 0;
  const realSave = app.backend.g.api_saveEntry;
  app.backend.g.api_saveEntry = (...a) => { calls++; return realSave(...a); };
  const btn = app.$('[data-act="save"]');
  app.click(btn); app.click(btn); app.click(btn);
  await app.until(() => !app.$('#page-entries').hidden && app.$('#page-entries .entry'), '回到列表');
  assert.equal(calls, 1);
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('entries').length, 1);
});

test('保存动画参数与客户确认的数值一致', async () => {
  const app = await openApp();
  const A = app.w.__app.SAVE_ANIM;
  assert.equal(A.SPEED, 0.8);
  assert.deepEqual([A.SHRINK_MS, A.CHECK_MS, A.BOUNCE_MS, A.PARTICLE_MIN_MS, A.PARTICLE_MAX_MS], [320, 350, 400, 600, 800]);
  assert.equal(A.PARTICLE_COUNT, 24);
  assert.equal(A.BURST_PX, 65);
  assert.equal(A.PARTICLE_SIZE_PX, 10);
  assert.equal(A.GLYPH_SCALE, 1.8);
  assert.equal(A.BOUNCE_PEAK, 1.22);
  assert.deepEqual(Array.from(A.SHAPES), ['dot', 'star', 'heart']);
  assert.deepEqual(Array.from(A.COLORS), ['#F0997B', '#D85A30', '#ED93B1', '#FAC775', '#D4537E']);
  assert.equal(A.SUCCESS_FILL, '#0F6E56');
});

test('网页：保存成功动画会迸发 24 个粒子；“减少动态效果”时不创建粒子', async () => {
  for (const reduced of [false, true]) {
    const app = await openApp({ reducedMotion: reduced });
    await app.openGrid();
    await app.pick('餐饮');
    app.keys('12');
    const btn = app.$('[data-act="save"]');
    app.click(btn);
    await app.until(() => btn.classList.contains('done'), '成功状态');
    const particles = app.$$('.save-particle');
    if (reduced) {
      assert.equal(particles.length, 0, '减少动态效果：没有粒子');
    } else {
      assert.equal(particles.length, 24);
      assert.deepEqual([...new Set(particles.map((p) => p.getAttribute('data-shape')))].sort(), ['dot', 'heart', 'star']);
    }
    await app.until(() => !app.$('#page-entries').hidden && app.$('#page-entries .entry'), '回到列表');
    assert.equal(app.$('#sum-expense').textContent, '$12.00');
    assert.deepEqual(app.errors, []);
  }
});

test('google.script.run：以 _ 结尾的内部函数无法从网页调用', async () => {
  const app = await openApp();
  const err = await new Promise((resolve) => {
    app.w.google.script.run.withFailureHandler(resolve).withSuccessHandler(() => resolve(null)).openLedger_();
  });
  assert.match(err.message, /not found/);
});

test('网页可调用的服务器函数清单（新增公开函数需要评审）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { MAIN } = require('./helpers/gas');
  const names = [];
  for (const f of ['web.js', 'jobs.js', 'store.js', 'gmail.js']) {
    const src = fs.readFileSync(path.join(MAIN, f), 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)) if (!m[1].endsWith('_')) names.push(m[1]);
  }
  assert.deepEqual(names.sort(), [
    'api_addCategory', 'api_addSource', 'api_archiveCategory', 'api_archiveSource', 'api_bootstrap',
    'api_deleteEntry', 'api_getEntry', 'api_getReport', 'api_listDeleted', 'api_listMonth',
    'api_refundCandidates', 'api_restoreEntry', 'api_saveEntry',
    // Task 05（预算与账单，2026-10-14 评审）：
    //  api_getBudgets      只读：某月预算总览（过去月份只读）
    //  api_setBudget       写（脚本锁内）：只改当前费城月份的预算，月份由服务器决定；空金额 = 取消；“未分类”服务器端拒绝
    //  api_setBudgetNearPct 写（脚本锁内）：预算提醒比例，只接受 50–100 的整数
    //  api_getMonthBills   只读：某年每月收入/支出/结余（与 computeReport 同口径）
    //  api_getYearBills    只读：每年收入/支出/结余
    'api_getBudgets', 'api_getMonthBills', 'api_getYearBills', 'api_setBudget', 'api_setBudgetNearPct',
    // Task 06（小助手，2026-10-14）：
    //  api_getAssistant      只读：最近 30 天的小助手消息、5 个问题按钮、未读数（消息里没有商家/备注）
    //  api_askAssistant      只读：按注册表里的问题 id 即时计算回答，不保存；未知 id 报错
    //  api_markAssistantRead 写（脚本锁内）：只把未读消息的 read_at 设为现在；工作表不存在时什么都不做
    'api_askAssistant', 'api_getAssistant', 'api_markAssistantRead',
    // Transaction report: creates a standalone period report file under the script lock; it reads but never changes ledger entries.
    'api_generateTransactionReport',
    // Task 10（Apple Pay 收件箱，2026-10-15）：
    //  api_keepDuplicates 写（脚本锁内）：只对标为“待核对重复”的账目生效；写 dup_dismissed、清除这一组的重复标记
    //  processInbox       定时任务（每 5 分钟）的入口，所以不能以 _ 结尾；网页调用时与打开网页时的自动整理相同：
    //                     幂等、在脚本锁内，只返回 {configured, created} 两个数字，不返回收件箱内容
    'api_keepDuplicates', 'processInbox',
    // Task 11（外卖收据，2026-10-15）：
    //  api_markMailReviewed  写（脚本锁内）：D16“待查看邮件”点“已查看”，只写 gmail_pending 那一行的 reviewed_at；
    //                        邮件编号格式不对或不在列表里时报错；不返回任何邮件内容
    //  pollReceipts          定时任务的入口（不能以 _ 结尾）；没有开启（脚本属性）时什么都不做；开启后与定时任务相同：
    //                        在脚本锁内、幂等，只返回数字和代码
    //  dryRunReceipts        G1 只读试运行（编辑器里运行）：只往执行日志写规则算出的值（编号后 6 位、日期、域名、分类、金额、标签），
    //                        不打开账本、不写任何东西；返回每个平台读了几封
    //  enableReceiptPolling / disableReceiptPolling  编辑器里运行的两阶段开关（幂等）：只增删 pollReceipts 定时器和开启标记；
    //                        与 installTriggers 一样只有你本人能调用
    'api_markMailReviewed', 'api_muteMailSender', 'api_addMailSenderAndRecord', 'disableReceiptPolling', 'dryRunReceipts', 'enableReceiptPolling', 'pollReceipts',
    // 储蓄目标与月底估算（2026-10-26 评审，测试见 tests/savings.test.js、tests/ui-savings.test.js）：
    //  api_getSavings                只读：储蓄目标、存入记录、本月估算和月底可用金额；旧账本没有储蓄表时返回 ready=false，不建表
    //  api_saveSavingsGoal           写（脚本锁内）：新建或修改储蓄目标；只写 savings_goals，不碰日常账目；新设日期必须在今天之后
    //  api_recordSavingsContribution 写（脚本锁内）：记一笔存入；网页生成的 request_id 就是行编号，同一编号重试只记一次、换了内容报错；
    //                                不能记未来日期；只写 savings_contributions，不计入收支、预算或报表
    //  api_saveSavingsEstimates      写（脚本锁内）：本月预计收入/支出；月份必须是服务器当前的费城月份，只写 savings_estimates
    'api_getSavings', 'api_recordSavingsContribution', 'api_saveSavingsEstimates', 'api_saveSavingsGoal',
    // 一次性修复（2026-10-26 评审，测试见 tests/store.test.js）：
    //  repairEntryColumns20261026  写（脚本锁内）：编辑器里运行一次；只改名单里 6 个账目编号、且仍是错位样子的行
    //                              （T/V 或 W 列），其他行列不碰；表头不一致时什么都不改；重复运行会跳过已修好的行；不返回账目内容
    'repairEntryColumns20261026',
    'dailyCleanup', 'doGet', 'include', 'installTriggers', 'setupLedger', 'testAddPendingEntry'
  ].sort());
});

test('testAddPendingEntry 没有开启脚本属性 ALLOW_TEST_ENTRY 时拒绝运行（网页调用也一样）', async () => {
  const app = await openApp();
  const err = await new Promise((resolve) => {
    app.w.google.script.run.withFailureHandler(resolve).withSuccessHandler(() => resolve(null)).testAddPendingEntry();
  });
  assert.match(err.message, /ALLOW_TEST_ENTRY/);
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('entries').length, 0);
});

test('网页：原交易删除后仍可编辑退款并保存', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '120', category: '餐饮', day: '03' });
  await app.addEntry({ amount: '20', day: '04', refund: '$120.00' });
  const g = app.backend.g;
  const repo = g.sheetRepo_(app.backend.ss);
  const orig = repo.list('entries').find((e) => e.amount_cents === 12000);
  const refund = repo.list('entries').find((e) => e.amount_cents === -2000);
  g.api_deleteEntry(orig.id);
  app.nav('entries');
  await app.until(() => app.$(`#page-entries [data-id="${refund.id}"]`), '列表');
  await app.openEdit(refund.id);
  assert.match(app.text('#chips'), /退款：.*原交易已删除/);
  app.chip('refund');
  await app.until(() => app.$('#f-refund-of'), '退款选择');
  assert.match(app.$('#f-refund-of').selectedOptions[0].textContent, /原交易已删除/);
  app.click(app.$('[data-act="key"][data-key="clear"]'));
  app.keys('25');
  await app.saveAndWait();
  assert.equal(g.sheetRepo_(app.backend.ss).list('entries').find((e) => e.id === refund.id).amount_cents, -2500);
  assert.deepEqual(app.errors, []);
});

// ================= 两步记账：类别网格 + 金额面板 =================

test('网页：类别网格按 sort 顺序显示当前类型的类别，“添加”在最后；切换标签；取消回到上一页', async () => {
  const app = await openApp();
  await app.openGrid();
  const names = () => app.$$('#catgrid .tile').map((t) => t.querySelector('.nm').textContent);
  const boot = app.w.__app.state.boot;
  const expected = (type) => boot.categories.filter((c) => c.type === type && !c.archived).sort((a, b) => a.sort - b.sort).map((c) => c.name);
  assert.deepEqual(names(), expected('expense').concat(['添加']));
  assert.equal(names()[names().length - 2], '未分类', '未分类在添加之前');
  assert.equal(names()[names().length - 3], '其他');
  assert.ok(names().indexOf('蔬菜') > names().indexOf('娱乐'), '新增的类别在原有类别之后');
  assert.ok(app.$('#catgrid .tile.add').classList.contains('add'));
  assert.equal(app.$('#grid-tabs .on').textContent, '支出');
  assert.equal(app.$('#entry-sheet').hidden, true, '选类别前没有金额面板');

  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('工资'), '收入网格');
  assert.deepEqual(names(), expected('income').concat(['添加']));
  assert.equal(names()[names().length - 2], '其他');
  // 已停用的类别不显示
  app.backend.g.api_archiveCategory(boot.categories.find((c) => c.name === '兼职').id);
  app.nav('entries');
  await app.until(() => app.$('#page-entries .monthnav'), '账目');
  // 取消：回到之前所在页面（账目页）
  await app.openGrid();
  app.click(app.$('[data-act="form-cancel"]'));
  assert.equal(app.$('#page-entries').hidden, false);
  assert.equal(app.$('#page-form').hidden, true);
  assert.deepEqual(app.errors, []);
});

test('网页：点类别打开金额面板；点面板顶部类别回到网格，金额和备注保留；换类别后沿用', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  assert.equal(app.text('#sheet-cat'), '餐饮');
  assert.ok(app.tile('餐饮').classList.contains('on'), '选中的类别高亮');
  app.keys('15.5');
  app.type('#f-note', '午饭');
  app.click(app.$('#sheet-cat'));
  assert.ok(!app.$('#entry-sheet').classList.contains('open'), '面板收起，回到网格');
  assert.equal(app.w.__app.state.draft.amount, '15.5');
  assert.equal(app.w.__app.state.draft.note, '午饭');
  await app.pick('交通');
  assert.equal(app.text('#sheet-cat'), '交通');
  assert.equal(app.text('#sheet-amt'), '$15.5');
  assert.equal(app.$('#f-note').value, '午饭');
  assert.ok(!app.tile('餐饮').classList.contains('on') && app.tile('交通').classList.contains('on'));
  await app.saveAndWait();
  const e = app.backend.g.sheetRepo_(app.backend.ss).list('entries')[0];
  assert.equal(e.amount_cents, 1550);
  assert.equal(e.note, '午饭');
  assert.equal(e.category_id, 'exp_transport');
  assert.deepEqual(app.errors, []);
});

test('数字键盘函数：小数最多两位、只能一个小数点、00、退格、清空、最大长度', async () => {
  const app = await openApp();
  const kp = (seq) => seq.reduce((v, k) => app.w.__app.keypadPress(v, k), '');
  assert.equal(kp(['1', '2', '.', '5']), '12.5');
  assert.equal(kp(['1', '.', '5', '0', '9']), '1.50', '最多两位小数');
  assert.equal(kp(['1', '.', '2', '.', '3']), '1.23', '只有一个小数点');
  assert.equal(kp(['.']), '0.', '直接按小数点 = 0.');
  assert.equal(kp(['5', '00']), '500');
  assert.equal(kp(['00']), '', '空的时候 00 不起作用');
  assert.equal(kp(['0', '00']), '0');
  assert.equal(kp(['0', '5']), '5', '0 后面再按数字不出现 05');
  assert.equal(kp(['1', '.', '5', '00']), '1.50', '小数部分 00 只补满两位');
  assert.equal(kp(['1', '2', 'back']), '1');
  assert.equal(kp(['back']), '');
  assert.equal(kp(['1', '.', 'back']), '1');
  assert.equal(kp(['1', '2', '3', 'clear']), '');
  assert.equal(kp(['1', '2', '3', '4', '5', '6', '7', '8', '9']), '1234567', '整数部分最多 7 位');
  assert.equal(kp(['9', '9', '9', '9', '9', '9', '9', '00']), '9999999');
  assert.equal(kp(['1', '2', '3', '4', '5', '6', '7', '.', '9', '9', '9']), '1234567.99');
});

test('网页：金额显示 $ + 当前输入；整个录入过程不会出现需要手机键盘的金额输入框', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  assert.equal(app.text('#sheet-amt'), '$0');
  app.keys('7.');
  assert.equal(app.text('#sheet-amt'), '$7.');
  app.key('5'); app.key('5'); app.key('5');
  assert.equal(app.text('#sheet-amt'), '$7.55');
  app.key('back'); assert.equal(app.text('#sheet-amt'), '$7.5');
  app.key('clear'); assert.equal(app.text('#sheet-amt'), '$0');
  assert.equal(app.$('#entry-sheet input[inputmode]'), null, '没有 inputmode 的金额输入框');
  assert.ok(app.$('#sheet-amt').classList.contains('expense'));
  app.click(app.$('#sheet-cat'));
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('工资'), '收入');
  await app.pick('工资');
  assert.ok(app.$('#sheet-amt').classList.contains('income'));
});

test('网页：新记录金额为空或为零时提示“先填金额”，不向服务器发请求', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  let calls = 0;
  const real = app.backend.g.api_saveEntry;
  app.backend.g.api_saveEntry = (...a) => { calls++; return real(...a); };
  const btn = app.$('[data-act="save"]');
  app.click(btn);
  assert.equal(app.$('#sheet-hint').hidden, false);
  assert.equal(app.text('#sheet-hint'), '先填金额');
  assert.ok(!btn.classList.contains('shrunk') && !btn.classList.contains('saving'), '按钮不播放保存动画');
  app.keys('0.');
  app.click(btn);
  assert.equal(app.text('#sheet-hint'), '先填金额', '零金额同样拦截');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
  app.key('5');
  assert.equal(app.$('#sheet-hint').hidden, true, '开始输入后提示消失');
  assert.equal(app.w.__app.state.saving, false);
  app.backend.g.api_saveEntry = real;
  await app.saveAndWait();
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('entries')[0].amount_cents, 50);
});

test('网页：小标签显示已填的值并可展开；退款标签只在支出，来源标签只在收入', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '40', category: '购物', day: '02' });
  await app.openGrid();
  await app.pick('餐饮');
  assert.deepEqual(app.chipNames(), ['date', 'merchant', 'refund']);
  assert.match(app.text('#chips .chip'), /^今天 \d\d:\d\d$/, '日期默认今天');
  assert.equal(app.$('#chip-panel').hidden, true);
  app.chip('merchant');
  assert.equal(app.$('#chip-panel').hidden, false);
  assert.ok(app.$('#f-merchant'), '展开商家输入框');
  app.type('#f-merchant', '麦当劳');
  assert.match(app.text('#chips'), /商家：麦当劳/);
  assert.ok(app.$$('#chips .chip').find((c) => c.dataset.chip === 'merchant').classList.contains('on'));
  app.chip('merchant');
  assert.equal(app.$('#chip-panel').hidden, true, '再点一次收起');
  assert.match(app.text('#chips'), /商家：麦当劳/, '收起后仍显示值');
  // 日期
  app.chip('date');
  app.set('#f-datetime', app.currentMonth() + '-02T09:30');
  assert.match(app.text('#chips'), /月 2 日 09:30/);
  // 退款：点一下就打开并选中，可选“不关联”或原交易
  app.chip('refund');
  assert.ok(app.$$('#f-refund-of option').length >= 2);
  assert.equal(app.$('#f-refund-of option').textContent, '不关联原交易');
  app.click(app.$('[data-act="refund-off"]'));
  assert.match(app.text('#chips'), /这是退款/);
  // 切换到收入：没有退款标签，出现来源标签
  app.click(app.$('#sheet-cat'));
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('兼职'), '收入');
  await app.pick('兼职');
  assert.deepEqual(app.chipNames(), ['date', 'merchant', 'source']);
  app.chip('source');
  const opts = app.$$('#f-source option').map((o) => o.textContent);
  assert.deepEqual([opts[0], opts[opts.length - 1]], ['不填', '＋ 新建来源…']);
  assert.match(app.text('#chips'), /商家：麦当劳/, '金额以外的内容换类型后保留');
  app.set('#f-source', '__new__');
  await app.until(() => app.$('#f-new-source'), '新来源输入');
  app.type('#f-new-source', '兼职 Z');
  assert.match(app.text('#chips'), /来源：兼职 Z/);
  assert.deepEqual(app.errors, []);
});

test('网页：收入可选已有来源、不填或新建来源；换到收入后之前的支出退款设置被清掉', async () => {
  const app = await openApp();
  await app.addEntry({ type: 'income', amount: '600', category: '兼职', source: '兼职 A', day: '02' });
  await app.openGrid();
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('兼职'), '收入');
  await app.pick('兼职');
  app.keys('100');
  app.chip('source');
  const a = app.$$('#f-source option').find((o) => o.textContent === '兼职 A');
  app.set('#f-source', a.value);
  assert.match(app.text('#chips'), /来源：兼职 A/);
  await app.saveAndWait();
  const incomes = app.backend.g.sheetRepo_(app.backend.ss).list('entries').filter((e) => e.type === 'income');
  assert.equal(incomes.length, 2);
  assert.equal(incomes[0].income_source_id, incomes[1].income_source_id, '复用了已有来源');
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('income_sources').length, 1);

  // 不填
  await app.openGrid();
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('工资'), '收入');
  await app.pick('工资');
  app.keys('50');
  await app.saveAndWait();
  const noSource = app.backend.g.sheetRepo_(app.backend.ss).list('entries').find((e) => e.category_id === 'inc_salary');
  assert.equal(noSource.income_source_id, null);

  // 先在支出里标记退款，再换到收入类别：退款状态不会带过去
  await app.openGrid();
  await app.pick('餐饮');
  app.chip('refund');
  assert.ok(app.w.__app.state.draft.is_refund);
  app.click(app.$('#sheet-cat'));
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.tile('工资'), '收入');
  await app.pick('工资');
  assert.equal(app.w.__app.state.draft.is_refund, false);
  assert.equal(app.w.__app.state.draft.type, 'income');
  assert.deepEqual(app.errors, []);
});

test('网页：编辑打开带内容的面板（类别、金额、标签值、备注）和“删除”；改类别后保存；删除', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '23.4', category: '购物', day: '03', merchant: '超市', note: '周末采购' });
  const entry = app.backend.g.sheetRepo_(app.backend.ss).list('entries')[0];
  await app.openEdit(entry.id);
  assert.equal(app.text('#page-title'), '编辑');
  assert.equal(app.text('#sheet-cat'), '购物');
  assert.equal(app.text('#sheet-amt'), '$23.4');
  assert.match(app.text('#chips'), /商家：超市/);
  assert.match(app.text('#chips'), /月 3 日 12:00/);
  assert.equal(app.$('#f-note').value, '周末采购');
  assert.ok(app.tile('购物').classList.contains('on'), '网格里高亮当前类别');
  const del = app.$('#sheet-actions [data-act="delete"]');
  assert.ok(del, '底部有删除');
  assert.ok(!app.$('#sheet-actions [data-act="restore"]'));

  // 换类别、改金额
  app.click(app.$('#sheet-cat'));
  await app.pick('日用');
  app.key('back');
  app.key('8');
  await app.saveAndWait();
  const after = app.backend.g.sheetRepo_(app.backend.ss).list('entries')[0];
  assert.equal(after.category_id, 'exp_daily');
  assert.equal(after.amount_cents, 2380);
  assert.equal(after.merchant, '超市');

  // 删除
  await app.openEdit(entry.id);
  app.click(app.$('#sheet-actions [data-act="delete"]'));
  await app.until(() => app.text('#toast').includes('已删除'), '删除');
  await app.until(() => !app.$(`#page-entries [data-id="${entry.id}"]`) && !app.$('#page-entries').hidden, '列表更新');
  assert.deepEqual(app.errors, []);
});

test('网页：已删除的账目打开后显示“恢复”，没有“完成”和“删除”；恢复后回到列表', async () => {
  const app = await openApp();
  await app.addEntry({ amount: '10', category: '餐饮', day: '03' });
  const g = app.backend.g;
  const entry = g.sheetRepo_(app.backend.ss).list('entries')[0];
  g.api_deleteEntry(entry.id);
  app.nav('entries');
  await app.until(() => app.text('#page-entries').includes('本月还没有记录'), '空列表');
  app.w.__app.openForm(entry.id);
  await app.until(() => app.$('#entry-sheet.open'), '面板');
  assert.match(app.text('#sheet-warn'), /已删除/);
  assert.ok(app.$('#sheet-actions [data-act="restore"]'));
  assert.equal(app.$('[data-act="save"]'), null, '没有完成键');
  assert.equal(app.$('[data-act="delete"]'), null, '没有删除');
  app.click(app.$('#sheet-actions [data-act="restore"]'));
  await app.until(() => app.text('#toast').includes('已恢复'), '恢复');
  await app.until(() => app.$(`#page-entries [data-id="${entry.id}"]`), '回到列表');
});

test('网页：备注或标签文字框有焦点时自定义键盘隐藏，失去焦点后回来；回车收起手机键盘', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  const sheet = app.$('#entry-sheet');
  assert.ok(!sheet.classList.contains('typing'));
  app.$('#f-note').focus();
  assert.ok(sheet.classList.contains('typing'), '备注聚焦：键盘隐藏');
  assert.equal(app.$('#keypad').getAttribute('aria-hidden'), 'true');
  app.$('#f-note').blur();
  assert.ok(!sheet.classList.contains('typing'), '失焦：键盘回来');
  app.chip('merchant');
  assert.ok(sheet.classList.contains('typing'), '展开商家会自动聚焦：键盘隐藏');
  app.$('#f-merchant').dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.ok(!sheet.classList.contains('typing'), '回车 = 收起手机键盘');
  // 下拉框不隐藏键盘
  app.chip('refund');
  assert.ok(!sheet.classList.contains('typing'));
  // 点面板空白处也会收起手机键盘
  app.$('#f-note').focus();
  assert.ok(sheet.classList.contains('typing'));
  app.click(app.$('#sheet-amt'));
  assert.ok(!sheet.classList.contains('typing'));
});

test('网页：网格“添加”用已有接口新建类别并直接选中；重名提示错误', async () => {
  const app = await openApp();
  await app.openGrid();
  app.click(app.$('#catgrid .tile.add'));
  assert.equal(app.$('#addcat-box').hidden, false);
  app.type('#f-newcat', '餐饮');
  app.click(app.$('[data-act="addcat-ok"]'));
  await app.until(() => app.text('#toast').includes('已有同名类别'), '重名提示');
  assert.equal(app.$('#addcat-box').hidden, false, '失败时输入框仍在');
  app.type('#f-newcat', '健身房');
  app.click(app.$('[data-act="addcat-ok"]'));
  await app.until(() => app.$('#entry-sheet.open'), '面板打开');
  assert.equal(app.text('#sheet-cat .nm'), '健身房');
  assert.equal(app.$('#addcat-box').hidden, true);
  const names = app.$$('#catgrid .tile').map((t) => t.querySelector('.nm').textContent);
  assert.equal(names[names.length - 1], '添加');
  assert.equal(names[names.length - 2], '健身房', '新类别排在已有类别之后、添加之前');
  assert.ok(app.tile('健身房').classList.contains('on'));
  assert.equal(app.tile('健身房').querySelector('.ic').textContent, '健', '自建类别显示首字');
  app.keys('9');
  await app.saveAndWait();
  assert.equal(app.backend.g.sheetRepo_(app.backend.ss).list('entries')[0].amount_cents, 900);
  assert.deepEqual(app.errors, []);
});

test('页面文件里没有外部网址', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { MAIN } = require('./helpers/gas');
  for (const f of ['ui/index.html', 'ui/app.js.html', 'ui/style.html']) {
    const src = fs.readFileSync(path.join(MAIN, f), 'utf8');
    assert.ok(!/https?:\/\//.test(src), f + ' 有外部网址');
  }
});
