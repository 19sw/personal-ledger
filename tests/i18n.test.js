'use strict';
/**
 * 界面语言（PRD 6B、spec 8A）：“我的”里切换中文 / English；英文模式下各页面没有漏翻的中文（用户自己输入的除外）；
 * 选择记在本机，重新打开仍然生效；切回中文完全恢复；交易表格按所选语言导出。数字均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');
const { createBackend } = require('./helpers/harness');

const MAR15 = '2026-03-15T16:00:00Z';
const CJK = /[㐀-鿿]/;
const USER_TEXT = ['健身房', '健'];      // 用户自建的类别（以及它的首字头像）按原样显示

/** 去掉用户自建内容后再看有没有中文 */
function withoutUserText(t) { return USER_TEXT.reduce((acc, u) => acc.split(u).join(''), t); }

function seed(backend) {
  const { g, ss } = backend;
  const save = (type, amount, category_id, local, extra = {}) => g.api_saveEntry(Object.assign({ type, amount, category_id, local_datetime: local }, extra));
  save('expense', '170', 'exp_dining', '2026-03-02T12:00', { merchant: 'Cafe' });
  save('expense', '80', 'exp_shopping', '2026-03-05T12:00', { merchant: 'Market' });
  save('income', '1000', 'inc_parttime', '2026-03-01T09:00', { new_source_name: 'Job A' });
  save('expense', '60', 'exp_dining', '2026-02-03T12:00');
  g.api_addCategory('expense', '健身房');
  const gym = g.api_bootstrap().categories.find((c) => c.name === '健身房').id;
  save('expense', '35', gym, '2026-03-06T15:00', { merchant: 'Gym' });
  g.api_setBudget('total', '1000');
  g.api_setBudget('exp_dining', '200');
  // 一笔读不到金额的 Apple Pay（待补全）
  const d = g.parseLocalNY('2026-03-08T12:00');
  g.sheetRepo_(ss).insert('entries', { id: 'ap-1', type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: '2026-03',
    date_ny: '2026-03-08', category_id: 'exp_uncategorized', merchant: 'Apple Pay', channel: 'apple_pay', source_key: 'ap:1',
    created_at: d.toISOString(), updated_at: d.toISOString() });
}

async function settle(app) { await new Promise((r) => setTimeout(r, 20)); }

/** 页面上还看得到的中文（去掉用户自建内容） */
function leftoverChinese(app) {
  const out = [];
  const tw = app.doc.createTreeWalker(app.doc.body, 4);
  let n;
  while ((n = tw.nextNode())) {
    const el = n.parentNode;
    if (!el || el.closest('script, style, [translate="no"]')) continue;
    const t = n.nodeValue.trim();
    if (t && CJK.test(withoutUserText(t))) out.push(t);
  }
  app.$$('[aria-label], [placeholder], [title]').forEach((el) => {
    if (el.closest('[translate="no"]')) return;
    ['aria-label', 'placeholder', 'title'].forEach((a) => { const v = el.getAttribute(a); if (v && CJK.test(v)) out.push(a + '=' + v); });
  });
  return out;
}

test('语言：默认中文；“我的”里点 English 立即切换，记在本机；切回中文恢复原文', async () => {
  const app = await openApp({ backend: { now: MAR15 }, lang: 'zh' });
  await app.until(() => app.$('#page-entries .monthnav'), '账目');
  assert.equal(app.doc.documentElement.lang, 'zh-CN');
  assert.equal(app.$('[data-nav="entries"] span').textContent, '账目');
  await app.openMe();
  assert.ok(app.$('#lang-seg [data-lang="zh"]').classList.contains('on'));
  app.click(app.$('#lang-seg [data-lang="en"]'));
  await app.until(() => app.$('#lang-seg [data-lang="en"].on'), '切到 English');
  await settle(app);
  assert.equal(app.doc.documentElement.lang, 'en');
  assert.equal(app.w.localStorage.getItem('ledger.lang'), 'en');
  assert.equal(app.$('[data-nav="entries"] span').textContent, 'Entries');
  assert.equal(app.text('#page-title'), 'Me');
  assert.match(app.text('#me-menu'), /Categories[\s\S]*Language/);
  assert.equal(app.$('#lang-seg [data-lang="zh"]').textContent, '中文', '语言选项本身不翻译');
  assert.deepEqual(leftoverChinese(app), []);

  app.click(app.$('#lang-seg [data-lang="zh"]'));
  await app.until(() => app.$('#lang-seg [data-lang="zh"].on'), '切回中文');
  await settle(app);
  assert.equal(app.doc.documentElement.lang, 'zh-CN');
  assert.equal(app.w.localStorage.getItem('ledger.lang'), 'zh');
  assert.equal(app.$('[data-nav="entries"] span').textContent, '账目');
  assert.equal(app.text('#page-title'), '我的');
  assert.match(app.text('#me-menu'), /类别管理[\s\S]*语言/);
  assert.deepEqual(app.errors, []);
});

test('语言：English 下逐页查看（账目、记一笔、报表四页、预算、我的及子页、小猫助手五个问题）没有漏翻的中文', async () => {
  const app = await openApp({ backend: { now: MAR15 }, lang: 'en', beforeOpen: seed });
  await app.until(() => app.$('#page-entries .monthnav'), 'Entries');
  await settle(app);
  const seen = {};
  const check = (where) => { const left = leftoverChinese(app); if (left.length) seen[where] = left; };
  assert.equal(app.text('#page-title'), 'Entries');
  assert.match(app.text('#page-entries'), /March 2026/);
  assert.match(app.text('#page-entries'), /Amount unknown/);
  assert.match(app.text('#page-entries'), /健身房/, '自建类别保持原样');
  check('entries');

  await app.openGrid();
  await app.pick('Dining');
  await settle(app);
  check('form');
  app.click(app.$('[data-act="form-cancel"]'));

  app.nav('report');
  await app.until(() => app.$('#report-tabs') && app.$('#page-report .card'), 'Reports');
  await settle(app);
  check('report-month');
  app.w.HTMLElement.prototype.scrollIntoView = () => {};   // jsdom 没有 scrollIntoView
  const tabs = { bills: '#bill-hero', savings: '.savings-forecast', habits: '#page-report .insights-table' };
  for (const tab of Object.keys(tabs)) {
    app.click(app.$(`#report-tabs [data-tab="${tab}"]`));
    await app.until(() => app.$(tabs[tab]), tab);
    await settle(app);
    check('report-' + tab);
    if (tab === 'bills') {
      app.click(app.$('[data-act="btab"][data-tab="year"]'));
      await app.until(() => app.$('[data-act="btab"][data-tab="year"].on') && !app.$('[data-act="yprev"]'), 'year bills');
      await settle(app);
      check('report-bills-year');
    }
  }

  app.nav('budget');
  await app.until(() => app.$('#budget-total'), 'Budget');
  await settle(app);
  assert.match(app.text('#budget-total'), /March total budget/);
  check('budget');

  await app.openMe();
  await settle(app);
  check('me');
  for (const sub of ['cats', 'sources', 'near', 'deleted', 'applepay', 'gmail']) {
    await app.openMeSub(sub);
    await settle(app);
    check('me-' + sub);
  }

  app.click(app.$('[data-act="assistant-open"]'));
  await app.until(() => !app.$('#assistant-overlay').hidden && app.$$('#aov-qs [data-act="assistant-ask"]').length === 5, 'Cat Assistant');
  await settle(app);
  check('assistant');
  for (let i = 0; i < 5; i++) {
    const before = app.$$('#aov-list .amsg.bot').length;
    app.click(app.$$('#aov-qs [data-act="assistant-ask"]')[i]);
    await app.until(() => app.$$('#aov-list .amsg.bot').length > before, 'answer ' + i);
    await settle(app);
  }
  check('assistant-answers');
  app.click(app.$('[data-act="table-start"]'));
  await app.until(() => app.$('#table-start-date'), 'report dates');
  await settle(app);
  check('assistant-table');

  assert.deepEqual(seen, {}, '这些地方还有中文：' + JSON.stringify(seen, null, 1));
  const missing = Object.keys(app.w.__i18nMissing).filter((k) => CJK.test(withoutUserText(k)));
  assert.deepEqual(missing, [], '对照表里查不到');
  assert.deepEqual(app.errors, []);
});

test('语言：重新打开网页仍是 English；删除时的确认框也是英文', async () => {
  const app = await openApp({ backend: { now: MAR15 }, lang: 'en', beforeOpen: seed });
  await app.until(() => app.$('#page-entries .monthnav'), 'Entries');
  await settle(app);
  assert.equal(app.$('[data-nav="report"] span').textContent, 'Reports');
  const asked = [];
  app.w.I18N.nativeConfirm = (m) => { asked.push(m); return false; };
  const id = app.backend.g.sheetRepo_(app.backend.ss).list('entries').find((e) => e.merchant === 'Cafe').id;
  await app.openEdit(id);
  app.click(app.$('[data-act="delete"]'));
  assert.deepEqual(asked, ['Delete this entry? You can restore it from "Me → Recently deleted" within 30 days.']);
  assert.deepEqual(app.errors, []);
});

test('语言：交易表格按所选语言写表头和默认类别；自建类别保持原样；中文不变', () => {
  const backend = createBackend({ now: MAR15 });
  seed(backend);
  const { g } = backend;
  const en = g.svcGenerateTransactionReport(g.sheetRepo_(backend.ss), '2026-03-01', '2026-03-31', 'en');
  const zh = g.svcGenerateTransactionReport(g.sheetRepo_(backend.ss), '2026-03-01', '2026-03-31');
  const cats = (r) => r.months[0].rows.map((x) => x.category);
  assert.ok(cats(en).includes('Dining') && cats(en).includes('Shopping') && cats(en).includes('Part-time'));
  assert.ok(cats(en).includes('健身房'), '自建类别没有英文名，保持原样');
  assert.ok(cats(en).includes('Apple Pay'));
  assert.ok(cats(zh).includes('餐饮'));
  assert.ok(en.months[0].rows.some((x) => x.status === 'Amount missing; Balance incomplete'));
  const values = g.transactionReportSheetValues_(en, 'en');
  assert.equal(values[0][0], 'Transaction Report (USD)');
  assert.deepEqual(Array.from(values[3]), ['Month', 'Description', 'Category', 'Income', 'Expense', 'Balance', 'Status']);
  assert.ok(values.some((row) => row[0] === 'Total budget'));
  assert.ok(!values.some((row) => row.some((c) => typeof c === 'string' && CJK.test(c) && c !== '健身房')), '英文表格里除了自建类别没有中文');
  assert.equal(g.transactionReportSheetValues_(zh)[3][0], '月份', '不传语言时保持中文');
});

test('语言：内置类别在 api_bootstrap 里带英文名，自建类别没有；英文名不写进表格', () => {
  const backend = createBackend({ now: MAR15 });
  const { g } = backend;
  g.api_addCategory('expense', '健身房');
  const cats = g.api_bootstrap().categories;
  assert.equal(cats.find((c) => c.id === 'exp_dining').name_en, 'Dining');
  assert.equal(cats.find((c) => c.id === 'exp_uncategorized').name_en, 'Uncategorized');
  assert.equal(cats.find((c) => c.name === '健身房').name_en, null);
  assert.ok(g.sheetRepo_(backend.ss).list('categories').every((c) => !('name_en' in c) || c.name_en === undefined), '表格里没有英文名列');
});

test('语言：翻译器保留首尾空白；跟上月比较的回答用 day 1 to day N，不写错序数词', async () => {
  const app = await openApp({ backend: { now: MAR15 }, lang: 'en' });
  await app.until(() => app.$('#page-entries .monthnav'), 'Entries');
  const tr = app.w.I18N.translate;
  assert.equal(tr('  账目 '), '  Entries ');
  assert.equal(tr('本月 1–2 日支出 $5.00；上月同期（2 月 1–2 日）支出 $3.00。'),
    'Spent $5.00 from day 1 to day 2 this month; $3.00 in the same period last month (Feb 1–2).');
});

