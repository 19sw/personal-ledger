'use strict';
/**
 * 网页冒烟测试（Task 11，外卖收据）：在 jsdom 里打开真实页面，后端是真实服务器代码，Gmail 是假的高级服务。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');
const { apiMessage, fakeGmail } = require('./helpers/gmail');
const F = require('./fixtures/synthetic-mail');

const recent = (minAgo = 5) => new Date(Date.now() - minAgo * 60000).toISOString();

function gmailBackend(messages, { enabledAt = recent(1) } = {}) {
  const gm = fakeGmail(messages.map(apiMessage));
  return { gm, backend: { props: enabledAt ? { GMAIL_POLLING_ENABLED_AT: enabledAt } : {}, gmail: gm.service } };
}

test('网页：外卖收据没开启时没有红色提示；我的 → 外卖收据自动记账显示“未开启”和开启方法', async () => {
  const app = await openApp();
  assert.equal(app.$('#gm-alert'), null);
  await app.openMe();
  assert.match(app.text('#mi-gmail'), /未开启/);
  await app.openMeSub('gmail');
  assert.match(app.text('#gm-status'), /还没有开启/);
  assert.match(app.text('#gm-status'), /dryRunReceipts/);
  assert.match(app.text('#gm-status'), /Uber 打车收据会记为“交通”/);
  assert.match(app.text('#gm-status'), /Uber Eats 收据会记为“餐饮”/);
  assert.match(app.text('#gm-status'), /名单邮件通常会在 Gmail 收到后约 15 分钟内记账/);
  assert.doesNotMatch(app.text('#gm-status'), /打车收据.*餐饮/);
  assert.equal(app.$('#gm-pending'), null, '没开启、也没有待查看邮件：不显示列表');
  assert.deepEqual(app.errors, []);
});

test('网页：开启后自动入账的外卖收据出现在列表里（Gmail（DoorDash）、Online Order）；平台状态显示最后入账', async () => {
  const x = gmailBackend([F.ddReceipt({ at: recent(6) })]);
  const app = await openApp({ backend: x.backend });
  app.backend.g.pollReceipts();
  app.nav('entries');
  await app.until(() => app.text('#page-entries').includes('Gmail（DoorDash）'), '外卖账目');
  assert.match(app.text('#page-entries'), /\$23\.45/);
  assert.match(app.text('#page-entries'), /Online Order/);
  assert.doesNotMatch(app.text('#page-entries'), /未分类/);
  const stored = app.backend.g.sheetRepo_(app.backend.ss).list('entries').find((entry) => entry.platform === 'doordash');
  assert.equal(stored.category_id, 'exp_dining', '来源显示标签不改写商家类别');
  assert.equal(app.$('#gm-alert'), null, '一切正常时没有红色提示');
  await app.openMe();
  assert.match(app.text('#mi-gmail'), /正常/);
  await app.openMeSub('gmail');
  const dd = app.$('#gm-platforms [data-platform="doordash"]');
  assert.match(dd.textContent, /最后入账/);
  assert.match(dd.textContent, /未验证/);
  assert.deepEqual(app.errors, []);
});

test('网页：Gmail 自动记录的 Uber 行程也按用户要求显示 Online Order，同时保留交通消费类别', async () => {
  const x = gmailBackend([F.uberRide({ at: recent(6) })]);
  const app = await openApp({ backend: x.backend });
  app.backend.g.pollReceipts();
  app.nav('entries');
  await app.until(() => app.text('#page-entries').includes('Online Order'), 'Uber 自动账目来源标签');
  const ride = app.backend.g.sheetRepo_(app.backend.ss).list('entries').find((entry) => entry.platform === 'uber');
  assert.equal(ride.category_id, 'exp_transport', '虽然显示 Online Order，已批准的交通消费类别仍保留');
  const row = app.$$('#page-entries .entry').find((entry) => entry.textContent.includes('Online Order'));
  assert.match(row.querySelector('.sub').textContent, /Online Order/);
  assert.match(row.querySelector('.sub').textContent, /Gmail（Uber）/);
  assert.deepEqual(app.errors, []);
});

test('网页：待查看邮件显示平台、日期、“在 Gmail 中打开”；点“已查看”后移除', async () => {
  const x = gmailBackend([F.genericReceipt({ at: recent(6) })]);
  const app = await openApp({ backend: x.backend });
  app.backend.g.pollReceipts();
  await app.openMe();
  assert.match(app.text('#mi-gmail'), /1 封待查看/);
  await app.openMeSub('gmail');
  const row = app.$('#gm-pending .gm-mail');
  assert.match(app.text('#gm-pending'), /名单外像收据的邮件不会自动记账/);
  assert.match(app.text('#gm-pending'), /以后自动记/);
  assert.match(app.text('#gm-pending'), /静音这个商家/);
  assert.match(app.text('#gm-pending'), /已查看/);
  assert.match(row.textContent, /shop\.example/);
  assert.match(row.textContent, /收到/);
  assert.match(row.textContent, /\$7\.25/);
  const a = row.querySelector('a');
  assert.equal(a.textContent, '在 Gmail 中打开');
  assert.equal(a.getAttribute('href'), 'https://mail.google.com/mail/u/0/#all/un0000000001');
  assert.equal(a.getAttribute('target'), '_blank');
  for (const secret of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'Your receipt']) assert.equal(app.text('#gm-pending').includes(secret), false);
  app.click(row.querySelector('[data-act="mail-reviewed"]'));
  await app.until(() => app.$('#gm-pending') && /没有待查看的邮件/.test(app.text('#gm-pending')), '已查看后移除');
  assert.deepEqual(app.errors, []);
});

test('网页：开启后超过 20 分钟没有运行 → 账目页红色提示“可能已停止”，点进去看状态', async () => {
  const x = gmailBackend([], { enabledAt: recent(60) });
  const app = await openApp({ backend: x.backend });
  await app.until(() => app.$('#gm-alert'), '红色提示');
  assert.match(app.text('#gm-alert'), /可能已停止/);
  app.click(app.$('#gm-alert [data-act="me-goto"]'));
  await app.until(() => app.$('#gm-status'), '外卖收据状态页');
  assert.match(app.text('#gm-status'), /可能已停止/);
  assert.deepEqual(app.errors, []);
});

test('网页：Gmail 授权失效时页面照常打开，显示红色提示', async () => {
  const x = gmailBackend([F.ddReceipt({ at: recent() })]);
  x.gm.fail.list = new Error('Invalid Credentials (401)');
  const app = await openApp({ backend: x.backend });
  app.backend.g.pollReceipts();
  app.nav('entries');
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  await app.openMe();
  assert.match(app.text('#mi-gmail'), /需要注意/);
  await app.openMeSub('gmail');
  assert.match(app.text('#gm-status'), /授权失效/);
  assert.deepEqual(app.errors, []);
});

test('网页：缺少 mail_senders（旧账本尚未重跑 setupLedger）也能打开并提示准备状态', async () => {
  const app = await openApp({ beforeOpen: (backend) => { delete backend.ss.sheets.mail_senders; } });
  await app.openMeSub('gmail');
  assert.ok(app.$('#gm-status'), '状态页正常渲染');
  assert.deepEqual(app.errors, []);
});

test('网页：待查看邮件提供自动记账和商家静音动作', async () => {
  const x = gmailBackend([
    F.genericReceipt({ id: 'un0000000021', domain: 'auto.example', at: recent(6) }),
    F.genericReceipt({ id: 'un0000000022', domain: 'quiet.example', at: recent(5) })
  ]);
  const app = await openApp({ backend: x.backend });
  app.backend.g.pollReceipts();
  await app.openMeSub('gmail');
  assert.equal(app.$('[data-id="un0000000021"] [data-act="mail-auto"]').textContent, '以后自动记');
  assert.equal(app.$('[data-id="un0000000021"] [data-act="mail-mute"]').textContent, '不再提醒这个商家');
  app.click(app.$('[data-id="un0000000021"] [data-act="mail-auto"]'));
  await app.until(() => app.backend.ss.sheets.entries.rows.length > 1, '加入名单并记账');
  const senderRows = app.backend.ss.sheets.mail_senders.rows;
  assert.ok(senderRows.some((r) => r[0] === 'auto.example' && r[3] === 'auto'));
  app.click(app.$('[data-id="un0000000022"] [data-act="mail-mute"]'));
  await app.until(() => app.backend.ss.sheets.mail_senders.rows.some((r) => r[0] === 'quiet.example' && r[3] === 'muted'), '静音商家');
  await app.until(() => app.$('[data-id="un0000000022"]') === null, '静音后刷新待查看列表');
  assert.equal(app.$('[data-id="un0000000022"]'), null, '静音后从待查看列表隐藏');
  assert.deepEqual(app.errors, []);
});
