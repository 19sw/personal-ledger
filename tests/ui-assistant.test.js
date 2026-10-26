'use strict';
/**
 * 网页测试（Task 06）：紧凑记账面板 + 遮罩关闭、我的页（黑猫头部 / 打卡卡片 / 菜单子页面）、
 * 左上角小猫助手（红点、对话窗口、标已读、问题按钮、头像表情）。
 * jsdom 打开真实页面，后端是真实服务器代码 + 假表格。数字均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openApp } = require('./helpers/app');
const { MAIN } = require('./helpers/gas');

function backendHelpers(app) {
  const { g, ss } = app.backend;
  const repo = () => g.sheetRepo_(ss);
  return {
    g, ss, repo, createdSpreadsheets: app.backend.createdSpreadsheets,
    entries: () => repo().list('entries'),
    messages: () => repo().list('assistant_messages'),
    addMsg: (id, skill, text, extra = {}) => repo().insert('assistant_messages', Object.assign({
      id, created_at: new Date().toISOString(), skill_id: skill, dedup_key: 'test:' + id, month: g.monthNY(new Date()), text
    }, extra))
  };
}
const backdrop = (app) => app.$('#sheet-backdrop');

// ---------------- 紧凑面板 + 遮罩 ----------------

test('面板：点遮罩关闭新记录，不保存，金额/备注/标签/选中的类别都清掉；再打开是空的', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  await app.openGrid();
  await app.pick('餐饮');
  assert.equal(backdrop(app).hidden, false, '面板打开时有遮罩');
  app.keys('12.5');
  app.type('#f-note', '午饭');
  app.chip('merchant');
  app.type('#f-merchant', '小店');
  assert.ok(app.$('#catgrid .tile.on'));
  let calls = 0;
  const real = b.g.api_saveEntry;
  b.g.api_saveEntry = (...a) => { calls++; return real(...a); };
  app.click(backdrop(app));
  await app.until(() => !app.$('#entry-sheet.open') && app.$('#entry-sheet').hidden, '面板关闭');
  assert.equal(calls, 0, '没有保存请求');
  assert.equal(b.entries().length, 0);
  assert.equal(backdrop(app).hidden, true);
  assert.equal(app.$('#catgrid .tile.on'), null, '选中高亮清除');
  assert.equal(app.$('#page-form').hidden, false, '留在类别网格');
  await app.pick('交通');
  assert.equal(app.text('#sheet-amt'), '$0');
  assert.equal(app.$('#f-note').value, '');
  assert.deepEqual(app.chipNames(), ['date', 'merchant', 'refund']);
  assert.equal(app.$$('#chips .chip.on').length, 0, '标签内容也清掉了');
  b.g.api_saveEntry = real;
  assert.deepEqual(app.errors, []);
});

test('面板：编辑时点遮罩 = 放弃修改，回到账目列表，账目不变', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  await app.addEntry({ amount: '12', category: '餐饮', note: '原备注' });
  const id = b.entries()[0].id;
  await app.openEdit(id);
  app.key('clear');
  app.keys('99');
  app.type('#f-note', '改了');
  app.click(backdrop(app));
  await app.until(() => !app.$('#page-entries').hidden, '回到列表');
  assert.equal(app.$('#page-form').hidden, true);
  const e = b.entries()[0];
  assert.equal(e.amount_cents, 1200);
  assert.equal(e.note, '原备注');
  assert.deepEqual(app.errors, []);
});

test('面板：保存动画进行中点遮罩无效（不会中途关闭）', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  app.keys('3');
  app.$('#page-entries').innerHTML = '';
  app.click(app.$('[data-act="save"]'));
  app.click(backdrop(app));
  assert.ok(app.$('#entry-sheet.open'), '仍然打开');
  await app.until(() => !app.$('#page-entries').hidden && app.$('#page-entries .monthnav'), '保存完成');
  assert.equal(backendHelpers(app).entries().length, 1);
});

test('面板：没有空白带 —— 顺序为 把手、类别+金额、（提示）、标签；金额占满一行；最宽 480px；遮罩在面板下面', async () => {
  const app = await openApp();
  await app.openGrid();
  await app.pick('餐饮');
  const kids = app.$$('#entry-sheet > *').filter((el) => !el.hidden && !(el.id === 'sheet-warn' && !el.innerHTML));
  assert.deepEqual(kids.slice(0, 3).map((el) => el.id || el.className), ['grab', 'sheet-head', 'chips']);
  assert.equal(app.$('#sheet-warn').innerHTML, '', '新记录没有提示块');
  assert.equal(app.$('#sheet-hint').hidden, true);
  // 空金额的样式类不能叫 empty：全局 .empty（列表空状态）有 40px 上下留白，曾造成面板里的空白带
  assert.ok(app.$('#sheet-amt').classList.contains('amt-empty'));
  assert.ok(!app.$('#sheet-amt').classList.contains('empty'), '记一笔金额框没有 empty 类');
  app.keys('5');
  assert.ok(!app.$('#sheet-amt').classList.contains('amt-empty'));
  app.key('back');
  assert.ok(!app.$('#sheet-amt').classList.contains('empty'));
  const css = fs.readFileSync(path.join(MAIN, 'ui', 'style.html'), 'utf8');
  assert.match(css, /\.sheet-amt \{ flex: 1; min-width: 0;/, '金额不会被压成竖排（之前空白带的原因）');
  assert.match(css, /\.sheet \{[^}]*max-width: 480px;[^}]*margin: 0 auto;/);
  assert.match(css, /\.sheet-backdrop \{[^}]*z-index: 7;[^}]*rgba\(30, 43, 38, 0\.28\)/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.sheet-backdrop/, '减少动态效果时遮罩没有渐变');
  assert.doesNotMatch(css, /sheet-open \{ padding-bottom/, '不再给网格加 470px 的留白');
});

// ---------------- 我的 ----------------

test('我的：黑猫头部（我的小账本、已陪你记账 N 天）、打卡卡片（连续 / 累计 / 本周 / 下一个里程碑 / 今天状态）', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  await app.openMe();
  assert.ok(app.$('#me-hero .cat-av.big svg.cat[data-mood="normal"]'), '头部是黑猫头像');
  assert.match(app.text('#me-hero'), /我的小账本/);
  assert.equal(app.text('#me-days'), '已陪你记账 0 天');
  assert.match(app.text('#ck-today'), /今天还没记账哦/);
  assert.equal(app.text('#ck-next'), '记下第一笔账，就完成第一次打卡啦');

  // 昨天、前天也打过卡 + 今天记一笔
  const today = b.g.dateNY(new Date());
  b.repo().insert('checkins', { date_ny: b.g.addDaysNY(today, -1), first_entry_at: new Date().toISOString() });
  b.repo().insert('checkins', { date_ny: b.g.addDaysNY(today, -2), first_entry_at: new Date().toISOString() });
  b.repo().insert('checkins', { date_ny: b.g.addDaysNY(today, -9), first_entry_at: new Date().toISOString() });
  await app.addEntry({ amount: '5', category: '餐饮' });
  await app.openMe();
  assert.equal(app.text('#me-days'), '已陪你记账 4 天');
  assert.equal(app.text('#ck-streak'), '3');
  assert.equal(app.text('#ck-total'), '4');
  assert.equal(app.text('#ck-today'), '今天已打卡 ✓');
  assert.equal(app.text('#ck-next'), '再打卡 3 天，就到 7 天里程碑啦');
  const days = app.$$('#ck-week .ckd');
  assert.deepEqual(days.map((d) => d.querySelector('.ckl').textContent), ['一', '二', '三', '四', '五', '六', '日']);
  const t = days.find((d) => d.classList.contains('today'));
  assert.equal(t.dataset.date, today);
  assert.ok(t.classList.contains('on') && t.querySelector('svg.paw'), '今天盖了爪印');
  days.filter((d) => d.classList.contains('future')).forEach((d) => assert.ok(!d.classList.contains('on')));
  assert.deepEqual(app.errors, []);
});

test('我的：菜单 类别管理 / 收入来源 / 预算提醒比例（显示当前 %）/ 最近删除，各自打开子页面，返回箭头回到菜单', async () => {
  const app = await openApp();
  await app.openMe();
  const items = app.$$('#me-menu .menu-item[data-sub]');   // 不含“音效”开关行
  assert.deepEqual(items.map((i) => i.querySelector('.mi-name').textContent), ['类别管理', '收入来源', '预算提醒比例', '最近删除', 'Apple Pay 自动记账', '外卖收据自动记账']);   // Task 10、Task 11 各新增一项
  assert.equal(app.text('#mi-near'), '80%');
  const expectSub = { cats: ['类别管理', '#new-cat-expense'], sources: ['收入来源', '#new-src'], near: ['预算提醒比例', '#f-near-pct'], deleted: ['最近删除', null], applepay: ['Apple Pay 自动记账', '#ap-status'], gmail: ['外卖收据自动记账', '#gm-status'] };
  for (const sub of Object.keys(expectSub)) {
    await app.openMeSub(sub);
    assert.equal(app.text('#me-sub-title'), expectSub[sub][0]);
    if (expectSub[sub][1]) assert.ok(app.$(expectSub[sub][1]), sub + ' 原有内容');
    assert.equal(app.$('#me-menu'), null);
    app.click(app.$('[data-act="me-back"]'));
    await app.until(() => app.$('#me-menu'), '返回菜单');
  }
  assert.match(app.text('#page-settings'), /没有已删除的账目|最近删除/);
  // 改比例后菜单显示新的 %
  await app.openMeSub('near');
  app.set('#f-near-pct', '90');
  await app.until(() => app.text('#toast').includes('90%'), '保存比例');
  app.click(app.$('[data-act="me-back"]'));
  await app.until(() => app.$('#mi-near') && app.text('#mi-near') === '90%', '菜单显示 90%');
  // 在子页面里添加类别后仍停在子页面
  await app.openMeSub('cats');
  app.set('#new-cat-expense', '健身房');
  app.click(app.$('[data-act="add-cat"][data-type="expense"]'));
  await app.until(() => app.text('#toast').includes('已添加') && app.text('#page-settings').includes('健身房'), '添加');
  assert.equal(app.text('#me-sub-title'), '类别管理');
  // 从底部导航重新进入“我的” = 回到主页面
  app.nav('settings');
  await app.until(() => app.$('#me-menu'), '主页面');
  assert.deepEqual(app.errors, []);
});

test('我的：还没有 checkins 表时提示运行 setupLedger，不出错', async () => {
  const app = await openApp();
  delete app.backend.ss.sheets.checkins;
  await app.openMe();
  assert.match(app.text('#ck-setup'), /setupLedger/);
  assert.equal(app.text('#me-days'), '已陪你记账 0 天');
  assert.deepEqual(app.errors, []);
});

// ---------------- 小猫助手 ----------------

test('小猫助手：每个页面左上角都有猫爪入口；记账后出现红点；打开窗口 → 标为已读、红点消失；返回关闭', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const btn = app.$('#assistant-btn');
  assert.ok(btn.querySelector('svg g[fill="#5DCAA5"] circle'), '内嵌 SVG 薄荷色猫爪');
  assert.equal(btn.querySelectorAll('svg g[fill="#F4A6B8"] circle').length, 4, '四个粉色趾垫');
  assert.equal(app.$('#assistant-dot').hidden, true, '还没有消息：没有红点');
  for (const page of ['report', 'budget', 'settings', 'entries']) {
    app.nav(page);
    await app.until(() => !app.$('#page-' + page).hidden, page);
    assert.ok(app.$('.topbar #assistant-btn'));
  }
  await app.addEntry({ amount: '5', category: '餐饮' });   // 第一次打卡 → 1 天里程碑
  await app.until(() => app.$('#assistant-dot').hidden === false, '红点');
  assert.match(app.$('#assistant-btn').getAttribute('aria-label'), /1 条新消息/);
  app.click(app.$('#assistant-btn'));
  await app.until(() => !app.$('#assistant-overlay').hidden && app.$('#aov-list .amsg.bot'), '对话窗口');
  assert.equal(app.text('#aov-title'), '小猫助手');
  const ms = app.$('#aov-list .amsg[data-skill="checkin_milestone"]');
  assert.ok(ms, '里程碑消息');
  assert.equal(ms.dataset.mood, 'happy');
  assert.ok(ms.querySelector('.cat-av[data-mood="happy"] svg'), '开心表情头像');
  await app.until(() => app.$('#assistant-dot').hidden, '红点消失');
  assert.equal(b.messages().filter((m) => !m.read_at).length, 0, '服务器上已读');
  assert.equal(b.g.api_bootstrap().assistant.unread_count, 0);
  app.click(app.$('[data-act="assistant-close"]'));
  assert.equal(app.$('#assistant-overlay').hidden, true);
  assert.deepEqual(app.errors, []);
});

test('小猫助手：选择日期后直接生成独立报表，并提供 Google Sheets 与 Excel；不会写入账本', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const month = app.currentMonth();
  await app.addEntry({ type: 'expense', amount: '6.25', category: '餐饮', day: '02', merchant: '午饭' });
  await app.addEntry({ type: 'income', amount: '10.00', category: '兼职', day: '03', merchant: '兼职收入' });
  b.g.api_setBudget('total', '100');
  b.g.api_setBudget('exp_dining', '20');
  const appleAt = b.g.parseLocalNY(month + '-04T12:00');
  const gmailAt = b.g.parseLocalNY(month + '-05T12:00');
  const now = new Date().toISOString();
  b.repo().insert('entries', { id: 'report-apple', type: 'expense', amount_cents: 500, occurred_at: appleAt.toISOString(), date_ny: b.g.dateNY(appleAt),
    month_ny: b.g.monthNY(appleAt), category_id: 'exp_uncategorized', merchant: '茶店', channel: 'apple_pay', source_key: 'applepay:report-test', created_at: now, updated_at: now });
  b.repo().insert('entries', { id: 'report-gmail', type: 'expense', amount_cents: 700, occurred_at: gmailAt.toISOString(), date_ny: b.g.dateNY(gmailAt),
    month_ny: b.g.monthNY(gmailAt), category_id: 'exp_uncategorized', merchant: '网店', channel: 'gmail_receipt', platform: 'doordash', source_key: 'gmail:report-test', created_at: now, updated_at: now });
  const ledgerBefore = JSON.stringify(b.entries());
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('[data-act="table-start"]'), '交易表格入口');
  app.click(app.$('[data-act="table-start"]'));
  assert.equal(app.$('#table-start-date').value, month + '-01');
  app.set('#table-start-date', month + '-01');
  app.set('#table-end-date', month + '-10');
  app.click(app.$('[data-act="table-generate"]'));
  await app.until(() => app.$('.table-report-link'), '生成报表链接');
  assert.equal(b.createdSpreadsheets.length, 1);
  const sheet = b.createdSpreadsheets[0].getSheets().find((item) => item.getName() === '交易明细');
  assert.equal(sheet.rows[3][0], '月份');
  assert.ok(sheet.rows.some((row) => row[0] instanceof Date && row[0].getFullYear() === Number(month.slice(0, 4)) && row[0].getMonth() + 1 === Number(month.slice(5, 7))), '按月份列出交易');
  assert.ok(sheet.rows.some((row) => row[1] === '午饭' && row[2] === '餐饮' && row[4] === 6.25));
  assert.ok(sheet.rows.some((row) => row[1] === '兼职收入' && row[3] === 10));
  assert.ok(sheet.rows.some((row) => row[0] === '总预算'), '有设置预算时包含当月预算对比');
  assert.ok(!sheet.rows.some((row) => row[0] === '餐饮'), '导出预算段不显示分类预算行');
  assert.ok(sheet.rows.some((row) => row[1] === '茶店' && row[2] === 'Apple Pay'));
  assert.ok(sheet.rows.some((row) => row[1] === '网店' && row[2] === 'Online Order'));
  const transactionRows = sheet.rows.filter((row) => ['午饭', '兼职收入', '茶店', '网店'].includes(row[1]));
  assert.deepEqual(transactionRows.map((row) => row[5]), [-6.25, 3.75, -1.25, -8.25], '余额连续累计');
  assert.equal(app.$('.table-report-link').getAttribute('href'), b.createdSpreadsheets[0].getUrl());
  assert.match(app.$$('.table-report-link')[1].getAttribute('href'), /export\?format=xlsx$/);
  assert.equal(app.text('#aov-list').includes('预览'), false);
  assert.equal(app.$('#table-input'), null);
  assert.equal(app.$('[data-act="table-confirm"]'), null);
  assert.equal(JSON.stringify(b.entries()), ledgerBefore, '生成报表只创建独立文件，不改账本');
  assert.deepEqual(app.errors, []);
});

test('小猫助手：5 个问题按钮（PRD 6A.4 顺序），点击先插入问题再插入回答；回答不保存、不出红点', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  await app.addEntry({ amount: '12', category: '餐饮' });
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$$('#aov-qs .aq').length === 5, '问题按钮');
  await app.until(() => app.$('#assistant-dot').hidden, '已读');
  assert.deepEqual(app.$$('#aov-qs .aq').map((q) => q.textContent),
    ['本月到今天的收支', '这个月还能花多少？', '哪个类别花得最多？', '跟上个月同期比怎么样？', '还有几笔没补全／待核对？']);
  const before = b.messages().length;
  const n = app.$$('#aov-list .amsg').length;
  app.click(app.$$('#aov-qs .aq')[0]);
  await app.until(() => app.$('#aov-list .amsg.answer'), '回答');
  const all = app.$$('#aov-list .amsg');
  assert.equal(all.length, n + 2);
  assert.ok(all[n].classList.contains('me'));
  assert.equal(all[n].textContent, '本月到今天的收支');
  assert.match(all[n + 1].textContent, /支出 \$12\.00/);
  assert.equal(all[n + 1].dataset.mood, 'normal');
  assert.ok(all[n + 1].querySelector('.aitem'), '类别明细是小行');
  app.click(app.$$('#aov-qs .aq')[2]);
  await app.until(() => app.$$('#aov-list .amsg.answer').length === 2, '第二个回答');
  assert.equal(b.messages().length, before, '回答不保存');
  assert.equal(app.$('#assistant-dot').hidden, true, '不出红点');
  assert.equal(b.g.api_bootstrap().assistant.unread_count, 0);
  assert.deepEqual(app.errors, []);
});

test('小猫助手：头像表情按消息类型（夸奖/里程碑开心，其余普通）；结构化消息显示小行；“去处理”跳到待处理', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const items = JSON.stringify([{ label: '预算', amount_cents: 20000 }, { label: '已用', amount_cents: 17000 }]);
  b.addMsg('m1', 'budget_near', '餐饮已用 85%，本月还剩 9 天，注意一下哦', { items_json: items });
  b.addMsg('m2', 'good_progress', '本月已经过去 65%，总预算才用了 40%，保持得很好！');
  b.addMsg('m3', 'checkin_milestone', '累计打卡 7 天！');
  b.addMsg('m4', 'last_month_praise', '上个月（9 月）比预算少花了 $120.00，做得好！');
  b.addMsg('m5', 'budget_over', '购物本月已超出预算 $30.00');
  b.addMsg('m6', 'budget_pace', '喵～本月每日平均预算 $19.35，目前日均支出 $28.71，照这个速度月底可能会超支哦');
  b.addMsg('m7', 'pending_items', '还有 1 笔金额没补全，补上后预算统计会更准哦', { action: 'goto:pending' });
  b.g.api_bootstrap();
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$$('#aov-list .amsg.bot').length === 7, '7 条消息');
  const mood = {};
  app.$$('#aov-list .amsg.bot').forEach((m) => { mood[m.dataset.skill] = m.querySelector('.cat-av').dataset.mood; });
  assert.deepEqual(mood, {
    budget_near: 'normal', good_progress: 'happy', checkin_milestone: 'happy', last_month_praise: 'happy',
    budget_over: 'normal', budget_pace: 'normal', pending_items: 'normal'
  });
  const near = app.$('#aov-list .amsg[data-skill="budget_near"]');
  assert.deepEqual(near.querySelectorAll('.aitem').length, 2);
  assert.match(near.textContent, /预算\$200\.00已用\$170\.00/);
  assert.ok(app.$('svg.cat[data-mood="happy"] path[fill="#F4A6B8"]'), '开心：粉色张嘴');
  assert.equal(app.$$('svg.cat[data-mood="normal"]')[0].querySelectorAll('circle[fill="#fff"]').length >= 2, true, '普通：圆眼睛');
  app.click(app.$('#aov-list [data-act="assistant-goto"]'));
  await app.until(() => app.$('#assistant-overlay').hidden && !app.$('#page-entries').hidden && app.$('#page-entries .monthnav'), '待处理列表');
  assert.equal(app.w.__app.state.filter, 'attention');
  assert.deepEqual(app.errors, []);
});

test('小猫助手：待查看邮件提醒的“去处理”直达我的 → 待查看邮件', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const now = new Date().toISOString();
  b.g.sheetRepo_(b.ss).insert('gmail_pending', { message_id: 'un0000000041', platforms: '', received_at: now,
    sender_domain: 'shop.example', amount_cents: 725, reason: 'UNLISTED', reviewed_at: null, created_at: now });
  b.addMsg('m-mail', 'pending_items', '还有 1 封待查看邮件', { action: 'goto:mail_pending' });
  b.g.api_bootstrap();
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('#aov-list [data-action="goto:mail_pending"]'), '待查看邮件提醒');
  app.click(app.$('#aov-list [data-action="goto:mail_pending"]'));
  await app.until(() => app.$('#gm-pending .gm-mail[data-id="un0000000041"]'), '打开待查看邮件');
  assert.equal(app.w.__app.state.meSub, 'gmail');
  assert.deepEqual(app.errors, []);
});

test('小猫助手：还没有 assistant_* 表时 —— 打开网页不写不建表、没有红点；窗口提示运行 setupLedger，问题照样能问', async () => {
  const app = await openApp();
  const { ss } = app.backend;
  for (const n of ['assistant_messages', 'assistant_state', 'checkins']) delete ss.sheets[n];
  await app.addEntry({ amount: '5', category: '餐饮' });
  assert.equal(app.$('#assistant-dot').hidden, true);
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('#aov-list .amsg.bot') && app.$$('#aov-qs .aq').length === 5, '窗口');
  assert.match(app.text('#aov-list'), /setupLedger/);
  app.click(app.$$('#aov-qs .aq')[1]);
  await app.until(() => app.$('#aov-list .amsg.answer'), '回答');
  assert.match(app.text('#aov-list .amsg.answer'), /还没有设置预算/);
  for (const n of ['assistant_messages', 'assistant_state', 'checkins']) assert.equal(ss.getSheetByName(n), null, n);
  assert.deepEqual(app.errors, []);
});

test('黑猫头像是原创的内嵌 SVG：只有简单几何形状，没有外部图片或网址', async () => {
  const app = await openApp();
  for (const mood of ['normal', 'happy']) {
    const svg = app.w.__app.catSvg(mood);
    assert.doesNotMatch(svg, /<image|href|url\(|https?:/);
    const tags = new Set([...svg.matchAll(/<([a-z]+)/g)].map((m) => m[1]));
    for (const t of tags) assert.ok(['svg', 'path', 'circle', 'ellipse'].includes(t), '只用基本图形：' + t);
    assert.match(svg, /#F4A6B8/, '粉色内耳');
    assert.match(svg, /#5DCAA5/, '薄荷色领结');
  }
});

test('预算面板金额框同样不带 empty 类；设置预算后红点立即更新', async () => {
  const app = await openApp();
  app.nav('budget');
  await app.until(() => app.$('#page-budget [data-act="budget-edit"]'), '预算页');
  app.click(app.$('#page-budget [data-act="budget-edit"]'));
  await app.until(() => app.$('#bs-amt'), '预算面板');
  assert.ok(app.$('#bs-amt').classList.contains('amt-empty'));
  assert.ok(!app.$('#bs-amt').classList.contains('empty'), '预算金额框没有 empty 类');
  // 本月已有 9 美元支出；把总预算设为 10 → 接近预算提醒，红点马上出现（不用刷新页面）
  const { g } = app.backend;
  g.api_saveEntry({ type: 'expense', amount: '9', category_id: 'exp_dining', local_datetime: g.api_bootstrap().now_local });
  g.api_markAssistantRead();
  app.w.__app.state.boot.assistant.unread_count = 0;
  app.$('#assistant-dot').hidden = true;
  for (const k of '10') app.click(app.$(`[data-act="bkey"][data-key="${k}"]`));
  app.click(app.$('[data-act="bs-save"]'));
  await app.until(() => app.$('#assistant-dot').hidden === false, '红点');
  assert.ok(g.api_bootstrap().assistant.unread_count >= 1, '接近预算（7 日以后可能还有超支速度提醒）');
  assert.deepEqual(app.errors, []);
});

// ---------------- 去处理：以前月份的待处理 ----------------

function addPendingAt(app, month, day, id) {
  const { g, ss } = app.backend;
  const d = g.parseLocalNY(month + '-' + day + 'T09:00');
  const now = new Date().toISOString();
  g.sheetRepo_(ss).insert('entries', { id, type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
    date_ny: g.dateNY(d), category_id: 'exp_uncategorized', merchant: 'Apple Pay', channel: 'apple_pay',
    source_key: 'applepay:evt:' + id, created_at: now, updated_at: now });
}

test('小猫助手：去处理 → 打开最早有待处理的月份；其他月份提示 + 下一个月份（往后找，到头回到最早）', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const cur = app.currentMonth();
  const m1 = b.g.addMonths(cur, -3), m2 = b.g.addMonths(cur, -1);
  addPendingAt(app, m1, '05', 'p-old');
  addPendingAt(app, m2, '06', 'p-mid');
  addPendingAt(app, cur, '07', 'p-cur');
  b.addMsg('m7', 'pending_items', '还有 3 笔金额没补全', { action: 'goto:pending' });
  b.g.api_bootstrap();
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('#aov-list [data-act="assistant-goto"]'), '消息');
  app.click(app.$('#aov-list [data-act="assistant-goto"]'));
  await app.until(() => app.$('#more-months') && app.w.__app.state.month === m1, '最早的月份');
  assert.equal(app.w.__app.state.filter, 'attention');
  assert.match(app.text('#more-months'), /其他月份还有 2 笔/);
  assert.ok(app.$('#page-entries [data-id="p-old"]'));
  app.click(app.$('#more-months [data-act="next-attention"]'));
  await app.until(() => app.w.__app.state.month === m2 && app.$('#page-entries [data-id="p-mid"]'), '下一个月份');
  app.click(app.$('#more-months [data-act="next-attention"]'));
  await app.until(() => app.w.__app.state.month === cur && app.$('#page-entries [data-id="p-cur"]'), '本月');
  app.click(app.$('#more-months [data-act="next-attention"]'));
  await app.until(() => app.w.__app.state.month === m1 && app.$('#page-entries [data-id="p-old"]'), '回到最早');
  assert.equal(app.w.__app.state.filter, 'attention');
  app.click(app.$('[data-act="toggle-filter"]'));      // 关掉筛选后不再提示
  await app.until(() => app.w.__app.state.filter === 'all' && !app.$('#more-months'), '无提示');
  assert.deepEqual(app.errors, []);
});

test('小猫助手：只有一个月有待处理时不显示“其他月份”；都处理完了去处理打开本月并显示没有需要处理', async () => {
  const app = await openApp();
  const b = backendHelpers(app);
  const cur = app.currentMonth();
  addPendingAt(app, cur, '07', 'p-cur');
  b.addMsg('m7', 'pending_items', '还有 1 笔金额没补全', { action: 'goto:pending' });
  b.g.api_bootstrap();
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('#aov-list [data-act="assistant-goto"]'), '消息');
  app.click(app.$('#aov-list [data-act="assistant-goto"]'));
  await app.until(() => app.$('#page-entries [data-id="p-cur"]'), '本月待处理');
  assert.equal(app.$('#more-months'), null);
  b.g.api_deleteEntry('p-cur');
  app.click(app.$('#assistant-btn'));
  await app.until(() => app.$('#aov-list [data-act="assistant-goto"]'), '消息');
  app.click(app.$('#aov-list [data-act="assistant-goto"]'));
  await app.until(() => /没有需要处理的记录/.test(app.text('#page-entries')), '没有需要处理');
  assert.equal(app.w.__app.state.month, cur);
  assert.equal(app.$('#more-months'), null);
  assert.deepEqual(app.errors, []);
});
