'use strict';
/**
 * 网页冒烟测试（Task 10，Apple Pay）：在 jsdom 里打开真实页面，后端是真实服务器代码；
 * 「收件箱」是一张假表格，由真正的收件口 doPost 写入。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');
const { loadInbox } = require('./helpers/inbox');
const { FakeSpreadsheet } = require('./helpers/fake-sheets');

function withInbox() {
  const inboxSs = new FakeSpreadsheet();
  const inbox = loadInbox({ ss: inboxSs, now: new Date().toISOString() });
  return { inbox, backend: { props: { INBOX_SPREADSHEET_ID: 'inbox-id' }, spreadsheets: { 'inbox-id': inboxSs } } };
}

test('网页：没有设置收件箱时页面正常，没有红色提示；我的 → Apple Pay 自动记账显示“未开启”', async () => {
  const app = await openApp();
  assert.equal(app.$('#ap-alert'), null);
  await app.openMe();
  assert.match(app.text('#mi-applepay'), /未开启/);
  await app.openMeSub('applepay');
  assert.match(app.text('#ap-status'), /还没有开启/);
  assert.deepEqual(app.errors, []);
});

test('网页：打开时整理收件箱，Apple Pay 在分类位置显示来源名且内部消费类别不变', async () => {
  const x = withInbox();
  x.inbox.pay('evt-ui-1', { occurred_at_text: '' });
  const app = await openApp({ backend: x.backend });
  await app.until(() => app.text('#page-entries').includes("TRADER JOE'S"), 'Apple Pay 账目');
  const t = app.text('#page-entries');
  assert.match(t, /\$12\.34/);
  assert.match(t, /Apple Pay/);
  const row = app.$$('#page-entries .entry').find((entry) => entry.textContent.includes("TRADER JOE'S"));
  assert.match(row.querySelector('.sub').textContent, /Apple Pay/);
  assert.doesNotMatch(row.querySelector('.sub').textContent, /未分类/);
  const stored = app.backend.g.sheetRepo_(app.backend.ss).list('entries').find((entry) => entry.merchant === "TRADER JOE'S");
  assert.equal(stored.category_id, 'exp_uncategorized', '显示来源标签不改存储消费类别');
  assert.equal(app.$('#ap-alert'), null, '一切正常时没有红色提示');
  await app.openMe();
  assert.match(app.text('#mi-applepay'), /正常/);
  await app.openMeSub('applepay');
  assert.match(app.text('#ap-status'), /最近一次入账/);
  assert.match(app.text('#ap-limits'), /最近 7 天没有被拒收的付款/);
  assert.deepEqual(app.errors, []);
});

test('网页：被限流时账目页有红色提示，点进去看到被拒笔数', async () => {
  const x = withInbox();
  for (let i = 1; i <= 12; i++) x.inbox.pay('evt-' + i);
  const app = await openApp({ backend: x.backend });
  await app.until(() => app.$('#ap-alert'), '红色提示');
  assert.match(app.text('#ap-alert'), /拒收了 2 笔付款.*手动补记/);
  app.click(app.$('#ap-alert [data-act="me-goto"]'));
  await app.until(() => app.$('#ap-limits'), 'Apple Pay 状态页');
  assert.match(app.text('#ap-limits'), /拒收 2 笔/);
  assert.deepEqual(app.errors, []);
});

test('网页：Apple Pay 与手动记录疑似重复 → 两笔都显示“可能重复”；点“两笔都保留”后标签消失', async () => {
  const x = withInbox();
  const app = await openApp({ backend: x.backend });
  const day = app.backend.g.dateNY(new Date());   // 费城的今天
  await app.addEntry({ amount: '12.34', category: '餐饮', day: day.slice(8, 10) });
  // 与手动记录同一天同金额的 Apple Pay（时间用收到时间；手动记录在当天 12:00，24 小时内）
  x.inbox.pay('evt-dup', { occurred_at_text: '' });
  app.backend.g.processInbox();
  app.nav('entries');
  await app.until(() => app.$$('#page-entries .tag').filter((t) => t.textContent === '可能重复').length === 2, '两笔都标可能重复');
  const ap = app.$$('#page-entries .entry').find((e) => e.textContent.includes("TRADER JOE'S"));
  await app.openEdit(ap.getAttribute('data-id'));
  assert.ok(app.$('#dup-box'));
  app.$('#page-entries').innerHTML = '';
  app.click(app.$('[data-act="keep-dups"]'));
  await app.until(() => app.$('#page-entries .monthnav'), '回到列表');
  assert.equal(app.$$('#page-entries .tag').filter((t) => t.textContent === '可能重复').length, 0);
  assert.equal(app.$$('#page-entries .entry').length, 2, '两笔都保留');
  assert.deepEqual(app.errors, []);
});
