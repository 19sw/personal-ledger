'use strict';
/**
 * 项目 M 的 Apple Pay 收件箱整理（spec 4.3、4.4、5.1 第 4 步、5.3、7A.3；§10 切片 3）。
 * 前半部分用内存 repo 测整理规则；后半部分把项目 I 的 doPost 和项目 M 的服务器代码接在同一张假「收件箱」上，
 * 走一遍线上的真实路径（收件口写入 → 打开网页 / 定时任务整理 → 账目、提醒、清理）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, memoryRepo, idGen, plain } = require('./helpers/gas');
const { createBackend } = require('./helpers/harness');
const { loadInbox } = require('./helpers/inbox');
const { FakeSpreadsheet } = require('./helpers/fake-sheets');

const H = 3600000;
const DAY = 24 * H;

function mSetup(nowIso = '2026-10-15T16:00:00.000Z') {
  const g = loadGas();
  const repo = memoryRepo(g);
  const newId = idGen('e');
  g.svcEnsureDefaults(repo);
  let now = new Date(nowIso);
  let n = 0;
  const t = {
    g, repo, newId,
    now: () => now,
    setNow(iso) { now = new Date(iso); },
    row(extra = {}) {
      n++;
      return Object.assign({ row_index: n + 1, row_type: 'txn', received_at: now.toISOString(), event_id: 'evt-' + n,
        amount_text: '$12.34', merchant_text: "TRADER JOE'S", occurred_at_text: '', shortcut_version: '1', rejected_count: null }, extra);
    },
    process(rows) { return plain(g.svcProcessInbox(repo, rows, now, newId)); },
    entries() { return repo.list('entries'); },
    live() { return repo.list('entries').filter((e) => !e.deleted_at); },
    manual(amount, local, extra = {}) {
      const cat = repo.list('categories').find((c) => c.name === '餐饮').id;
      return g.svcSaveEntry(repo, Object.assign({ type: 'expense', amount, category_id: cat, local_datetime: local }, extra), now, newId);
    }
  };
  return t;
}

// ---------------- 解析 ----------------

test('金额文字解析：$12.34、12.34、US$1,234.00 可识别；空、乱码、负数、0、不规范千位符 → 空（待补全）', () => {
  const { g } = mSetup();
  const cases = { '$12.34': 1234, '12.34': 1234, 'US$1,234.00': 123400, ' $5 ': 500, '12.3': 1230, '1,234.56 USD': 123456,
    '': null, '   ': null, 'abc': null, '¥12': null, '-$5.00': null, '-5': null, '0': null, '$0.00': null, '1,2': null,
    '12.345': null, '$12.34 tip': null, '(12.34)': null };
  for (const [text, want] of Object.entries(cases)) assert.equal(g.parseApplePayAmount(text), want, JSON.stringify(text));
  assert.equal(g.parseApplePayAmount(null), null);
  assert.equal(g.parseApplePayAmount(undefined), null);
});

test('交易时间：带时区偏移的 ISO 时间换算成 UTC 归月；认不出、没有时区或相差太多时用收到时间', () => {
  const { g } = mSetup();
  const rec = '2026-02-01T04:31:00.000Z';
  assert.equal(g.applePayOccurredAt('2026-01-31T23:30:00-05:00', rec).toISOString(), '2026-02-01T04:30:00.000Z');
  assert.equal(g.monthNY(g.applePayOccurredAt('2026-01-31T23:30:00-05:00', rec)), '2026-01', '费城 1 月 31 日 23:30 → 1 月');
  assert.equal(g.applePayOccurredAt('2026-01-31T23:30:00-0500', rec).toISOString(), '2026-02-01T04:30:00.000Z');
  assert.equal(g.applePayOccurredAt('2026-02-01T04:30:00Z', rec).toISOString(), '2026-02-01T04:30:00.000Z');
  for (const bad of ['', 'yesterday', '2026-01-31 23:30', '2026-01-31T23:30:00', 'Jan 31, 2026 at 11:30 PM',
    '2026-01-29T23:30:00-05:00' /* 早于收到时间 24 小时以上 */, '2026-02-01T05:00:00Z' /* 晚于收到时间 10 分钟以上 */]) {
    assert.equal(g.applePayOccurredAt(bad, rec).toISOString(), rec, bad);
  }
});

// ---------------- 整理 ----------------

test('一行收件 → 一笔 Apple Pay 支出：未分类、channel=apple_pay、来源凭据、打卡、月份时间', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const r = t.process([t.row({ event_id: 'evt-a', occurred_at_text: '2026-10-15T11:58:00-04:00', received_at: '2026-10-15T15:59:00.000Z' })]);
  assert.equal(r.created, 1);
  const e = t.entries()[0];
  assert.equal(e.type, 'expense');
  assert.equal(e.amount_cents, 1234);
  assert.equal(e.merchant, "TRADER JOE'S");
  assert.equal(e.channel, 'apple_pay');
  assert.equal(e.category_id, 'exp_uncategorized');
  assert.equal(e.source_key, 'applepay:evt:evt-a');
  assert.equal(e.occurred_at, '2026-10-15T15:58:00.000Z');
  assert.equal(e.month_ny, '2026-10');
  assert.equal(e.date_ny, '2026-10-15');
  assert.deepEqual(plain(t.repo.list('processed_sources')), [{ source_key: 'applepay:evt:evt-a', entry_id: e.id, outcome: 'created', processed_at: '2026-10-15T16:00:00.000Z' }]);
  assert.deepEqual(t.repo.list('checkins').map((c) => c.date_ny), ['2026-10-15'], 'svcOnEntryCreated_ 记了打卡');
  assert.equal(t.repo.list('month_meta')[0].month, '2026-10');
  const view = t.g.svcGetEntry(t.repo, e.id);
  assert.equal(view.channel_label, 'Apple Pay');
  assert.equal(view.category_name, '未分类');
});

test('手动运行快捷指令（金额、商家、时间都为空）→ 一笔“待补全”，商家显示 Apple Pay，时间用收到时间（D4）', () => {
  const t = mSetup();
  t.process([t.row({ amount_text: '', merchant_text: '', occurred_at_text: '' })]);
  const e = t.entries()[0];
  assert.equal(e.amount_cents, null);
  assert.equal(e.merchant, 'Apple Pay');
  assert.equal(e.occurred_at, t.now().toISOString());
  assert.equal(t.g.entryStatus(e), 'pending');
  assert.equal(t.g.svcGetEntry(t.repo, e.id).status_label, '待补全');
});

test('乱码金额 → 待补全；商家有控制字符或超长 → 清理、截断到 200 字', () => {
  const t = mSetup();
  t.process([t.row({ amount_text: 'garbage', merchant_text: '  A\nB  ' }), t.row({ merchant_text: 'M'.repeat(300) })]);
  const [a, b] = t.entries();
  assert.equal(a.amount_cents, null);
  assert.equal(a.merchant, 'A B');
  assert.equal(b.merchant.length, 200);
});

test('同一个 event_id：处理两次、收件箱里出现两行，都只有一笔账目', () => {
  const t = mSetup();
  const row = t.row({ event_id: 'evt-dup' });
  assert.equal(t.process([row]).created, 1);
  assert.equal(t.process([row]).created, 0);
  assert.equal(t.process([row, Object.assign({}, row, { row_index: 99 })]).created, 0);
  const t2 = mSetup();
  const r2 = t2.row({ event_id: 'same' });
  assert.equal(t2.process([r2, Object.assign({}, r2, { row_index: 3 })]).created, 1, '同一次整理里的两行也只记一笔');
  assert.equal(t2.entries().length, 1);
  assert.equal(t2.repo.list('processed_sources').length, 1);
});

test('被删除的 Apple Pay 账目不会重新出现：删除后、以及 30 天后彻底清除后再整理，都不新增', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const row = t.row({ event_id: 'evt-del' });
  t.process([row]);
  const id = t.entries()[0].id;
  t.g.svcDeleteEntry(t.repo, id, t.now());
  assert.equal(t.process([row]).created, 0);
  t.setNow('2026-11-20T16:00:00.000Z');
  assert.equal(t.g.svcPurgeDeleted(t.repo, t.now()).purged, 1);
  assert.equal(t.entries().length, 0);
  assert.equal(t.process([row]).created, 0);
  assert.equal(t.entries().length, 0);
  assert.equal(t.repo.list('processed_sources').length, 1, 'processed_sources 永不清理');
});

test('上次在“写账目”和“写凭据”之间中断：只补写凭据，不再多记一笔', () => {
  const t = mSetup();
  const row = t.row({ event_id: 'evt-half' });
  t.process([row]);
  t.repo.tables.processed_sources = [];          // 模拟凭据没写上
  const r = t.process([row]);
  assert.equal(r.created, 0);
  assert.equal(r.repaired, 1);
  assert.equal(t.entries().length, 1);
  assert.equal(t.repo.list('processed_sources')[0].entry_id, t.entries()[0].id);
});

test('限流标记行不会被当成交易；没有“未分类”类别时不入账、记录错误，行留着下次再试', () => {
  const t = mSetup();
  assert.equal(t.process([t.row({ row_type: 'rate_limited', event_id: '', rejected_count: 2 })]).created, 0);
  assert.equal(t.entries().length, 0);
  t.repo.tables.categories = t.repo.tables.categories.filter((c) => c.system_key !== 'uncategorized');
  const r = t.process([t.row()]);
  assert.equal(r.created, 0);
  assert.equal(r.error_code, 'NO_UNCATEGORIZED');
  assert.equal(t.repo.list('processed_sources').length, 0);
});

// ---------------- 跨渠道疑似重复（spec 4.4） ----------------

test('Apple Pay 与手动记录同金额、24 小时内、商家相近 → 两笔都标待核对重复，共享 dup_group，不合并不删除', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const m = t.manual('12.34', '2026-10-15T09:00');           // 手动记录没有商家 = 视为相近
  t.process([t.row({ occurred_at_text: '2026-10-15T11:00:00-04:00' })]);
  const [a, b] = t.entries();
  assert.equal(a.id, m.id);
  assert.equal(a.flag_dup, true);
  assert.equal(b.flag_dup, true);
  assert.ok(a.dup_group && a.dup_group === b.dup_group);
  assert.equal(t.g.svcGetEntry(t.repo, a.id).status, 'dup_review');
  assert.equal(t.live().length, 2);
});

test('Apple Pay 与 DoorDash（Gmail 收据）同金额、24 小时内 → 两笔都标待核对重复', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  t.repo.insert('entries', { id: 'dd-1', type: 'expense', amount_cents: 2599, occurred_at: '2026-10-15T01:00:00.000Z', month_ny: '2026-10',
    date_ny: '2026-10-14', category_id: 'exp_dining', merchant: 'DoorDash', channel: 'gmail_receipt', platform: 'doordash',
    flag_dup: false, dup_group: null, source_key: 'gmail:msg:x', created_at: '2026-10-15T01:00:00.000Z', deleted_at: null });
  t.process([t.row({ amount_text: '$25.99', merchant_text: 'DoorDash*McDonalds' })]);
  const dd = t.entries().find((e) => e.id === 'dd-1');
  const ap = t.entries().find((e) => e.channel === 'apple_pay');
  assert.equal(dd.flag_dup, true);
  assert.equal(ap.flag_dup, true);
  assert.equal(dd.dup_group, ap.dup_group);
});

test('不算重复：金额不同、超过 24 小时、商家不相近、同一渠道、金额为空、对方已删除', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  t.manual('12.35', '2026-10-15T09:00');                                        // 金额不同
  t.manual('12.34', '2026-10-14T09:00', { merchant: 'Trader Joes' });           // 超过 24 小时（相差 > 24h）
  t.manual('12.34', '2026-10-15T10:00', { merchant: 'Whole Foods' });           // 商家不相近
  const del = t.manual('12.34', '2026-10-15T10:30');                             // 已删除
  t.g.svcDeleteEntry(t.repo, del.id, t.now());
  t.process([t.row({ event_id: 'ap-1', occurred_at_text: '2026-10-15T11:00:00-04:00' })]);
  t.process([t.row({ event_id: 'ap-2', occurred_at_text: '2026-10-15T11:05:00-04:00' })]);   // 两笔 Apple Pay：同一渠道
  t.process([t.row({ event_id: 'ap-3', amount_text: '' })]);
  assert.ok(t.entries().every((e) => !e.flag_dup), JSON.stringify(t.entries().filter((e) => e.flag_dup).map((e) => e.merchant)));
});

test('商家相近：规范化后一方包含另一方（大小写、标点、全角）；Apple Pay 拿不到商家时视为空', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  assert.equal(t.g.merchantKey("DoorDash*McDonald's"), 'doordashmcdonalds');
  assert.equal(t.g.merchantKey('ＴＲＡＤＥＲ　ＪＯＥ’Ｓ'), 'traderjoes');
  t.manual('8.00', '2026-10-15T10:00', { merchant: 'Trader Joe’s #552' });
  t.process([t.row({ event_id: 'x1', amount_text: '8.00', merchant_text: 'TRADER JOES' })]);
  t.manual('9.00', '2026-10-15T10:00', { merchant: 'Some Cafe' });
  t.process([t.row({ event_id: 'x2', amount_text: '9.00', merchant_text: '' })]);   // 商家为空 → 显示 Apple Pay，比较时视为空
  const flagged = t.entries().filter((e) => e.flag_dup).map((e) => e.amount_cents).sort();
  assert.deepEqual(flagged, [800, 800, 900, 900]);
});

test('先有 Apple Pay、后手动记同一笔：保存手动记录时也会两笔都标待核对重复', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  t.process([t.row({ occurred_at_text: '2026-10-15T11:00:00-04:00' })]);
  const m = t.manual('12.34', '2026-10-15T11:10');
  assert.equal(m.status, 'dup_review', '保存后返回的就是“待核对重复”');
  assert.ok(t.entries().every((e) => e.flag_dup));
});

test('“两笔都保留”：清除标记、写 dup_dismissed；之后再检查（重新整理、再记一笔别的）这两笔不再被标记', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const m = t.manual('12.34', '2026-10-15T09:00');
  const row = t.row({ occurred_at_text: '2026-10-15T11:00:00-04:00' });
  t.process([row]);
  const ap = t.entries().find((e) => e.channel === 'apple_pay');
  const v = t.g.svcKeepDuplicates(t.repo, ap.id, t.now());
  assert.equal(v.status, 'normal');
  assert.ok(t.entries().every((e) => !e.flag_dup && !e.dup_group));
  assert.deepEqual(plain(t.repo.list('dup_dismissed')), [{ pair_key: [m.id, ap.id].sort().join('|'), entry_a: [m.id, ap.id].sort()[0], entry_b: [m.id, ap.id].sort()[1] }]);
  // 再跑一次检查：被保留的这一对不再被标记
  t.g.svcFlagCrossChannelDups_(t.repo, ap, t.newId);
  t.g.svcFlagCrossChannelDups_(t.repo, t.entries().find((e) => e.id === m.id), t.newId);
  t.process([row]);
  assert.ok(t.entries().every((e) => !e.flag_dup));
  // 第三笔同金额的手动记录：与 Apple Pay 那笔是新的一对，照常标记；被保留的那一对仍不标
  const m2 = t.manual('12.34', '2026-10-15T12:00');
  const flagged = t.entries().filter((e) => e.flag_dup).map((e) => e.id).sort();
  assert.deepEqual(flagged, [ap.id, m2.id].sort());
  assert.throws(() => t.g.svcKeepDuplicates(t.repo, m.id, t.now()), /没有被标为可能重复/);
});

test('“删除这一笔”：同组只剩一笔时它不再是待核对重复；恢复后两笔重新标记', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const m = t.manual('12.34', '2026-10-15T09:00');
  t.process([t.row({ occurred_at_text: '2026-10-15T11:00:00-04:00' })]);
  const ap = t.entries().find((e) => e.channel === 'apple_pay');
  t.g.svcDeleteEntry(t.repo, m.id, t.now());
  assert.equal(t.repo.list('entries').find((e) => e.id === ap.id).flag_dup, false);
  t.g.svcRestoreEntry(t.repo, m.id, t.now());
  assert.ok(t.entries().every((e) => e.flag_dup));
});

// ---------------- 收件箱状态与清理 ----------------

test('超过 7 天仍未整理的收件行会被数出来并报警；已整理的、7 天内的、标记行不算', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const now = t.now().getTime();
  const rows = [
    t.row({ event_id: 'old-unprocessed', received_at: new Date(now - 8 * DAY).toISOString() }),
    t.row({ event_id: 'old-processed', received_at: new Date(now - 8 * DAY).toISOString() }),
    t.row({ event_id: 'recent', received_at: new Date(now - 6 * DAY).toISOString() }),
    t.row({ row_type: 'rate_limited', event_id: '', received_at: new Date(now - 9 * DAY).toISOString(), rejected_count: 1 })
  ];
  assert.equal(t.g.countStaleInboxRows(rows, { 'applepay:evt:old-processed': true }, t.now()), 1);
  // 状态页与首页：channel_status.stale_count > 0 → 红色警告
  t.g.svcRecordChannelRun_(t.repo, 'apple_pay', t.now(), { ok: true, created: 0, stale_count: 1 });
  const st = plain(t.g.svcApplePayStatus(t.repo, t.now(), true));
  assert.equal(st.stale_count, 1);
  assert.ok(st.warnings.some((w) => /1 笔超过 7 天还没整理/.test(w)));
  // 整理成功后（全部有凭据）报警消失
  assert.equal(t.process(rows).stale_count, 0);
});

test('收件箱原始行 30 天后清除（交易行和标记行都清，时间认不出的不删），processed_sources 不受影响', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  const now = t.now().getTime();
  const rows = [
    { row_index: 2, row_type: 'txn', received_at: new Date(now - 31 * DAY).toISOString() },
    { row_index: 3, row_type: 'rate_limited', received_at: new Date(now - 30 * DAY - 1).toISOString() },
    { row_index: 4, row_type: 'txn', received_at: new Date(now - 30 * DAY).toISOString() },
    { row_index: 5, row_type: 'txn', received_at: 'not a time' },
    { row_index: 6, row_type: 'txn', received_at: new Date(now - DAY).toISOString() }
  ];
  assert.deepEqual(Array.from(t.g.selectInboxPurgeRows(rows, t.now())), [2, 3]);
});

test('网页加载：没有设置收件箱时 Apple Pay 显示为“未开启”，没有警告，也不报错', () => {
  const b = createBackend();
  const boot = plain(b.g.api_bootstrap());
  assert.equal(boot.apple_pay.configured, false);
  assert.deepEqual(boot.apple_pay.warnings, []);
  assert.deepEqual(plain(b.g.processInbox()), { configured: false, created: 0 });
});

test('网页加载：收件箱设置了但打不开 / 没有 inbox 工作表 / 表头不对 → 网页照常打开，只记录错误代码并提示', () => {
  for (const [books, code] of [[{}, 'INBOX_OPEN_FAILED'], [{ 'inbox-id': new FakeSpreadsheet() }, 'INBOX_SHEET_MISSING']]) {
    const b = createBackend({ props: { INBOX_SPREADSHEET_ID: 'inbox-id' }, spreadsheets: books });
    const boot = plain(b.g.api_bootstrap());
    assert.equal(boot.apple_pay.configured, true);
    assert.equal(boot.apple_pay.error.code, code);
    assert.ok(boot.apple_pay.warnings.some((w) => /Apple Pay 自动记账出错/.test(w)));
    assert.ok(!JSON.stringify(boot).includes('inbox-id'), '状态里不出现表格 ID');
  }
  const bad = new FakeSpreadsheet();
  bad.insertSheet('inbox').rows.push(['wrong', 'header']);
  const b = createBackend({ props: { INBOX_SPREADSHEET_ID: 'inbox-id' }, spreadsheets: { 'inbox-id': bad } });
  assert.equal(plain(b.g.api_bootstrap()).apple_pay.error.code, 'INBOX_HEADER_MISMATCH');
});

test('跨渠道重复检查出错：账目和凭据照常写入、月份时间照常更新，不算整理失败（不报 ROW_FAILED）', () => {
  const t = mSetup('2026-10-15T16:00:00.000Z');
  t.g.svcFlagCrossChannelDups_ = () => { throw new Error('dup boom'); };
  const r = t.process([t.row({ event_id: 'evt-throw' })]);
  assert.equal(r.created, 1);
  assert.equal(r.errors, 0);
  assert.equal(r.error_code, null);
  assert.equal(t.entries().length, 1);
  assert.equal(t.repo.list('processed_sources').length, 1);
  assert.deepEqual(plain(t.repo.list('month_meta')), [{ month: '2026-10', last_changed_at: '2026-10-15T16:00:00.000Z' }]);
});

test('定时任务 processInbox：没设置收件箱时不拿锁、不打开账本；拿不到锁时记一个代码后返回，不抛错', () => {
  const off = createBackend();
  const opensBefore = off.ledgerOpens();
  const attemptsBefore = off.lock.attempts;
  assert.deepEqual(plain(off.g.processInbox()), { configured: false, created: 0 });
  assert.equal(off.lock.attempts, attemptsBefore, '没拿锁');
  assert.equal(off.ledgerOpens(), opensBefore, '没打开账本');

  const x = e2e();
  x.inbox.pay('evt-busy');
  x.b.lock.allow = false;
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  let r;
  try { r = plain(x.b.g.processInbox()); } finally { console.warn = orig; }
  assert.deepEqual(r, { configured: true, created: 0, skipped: true });
  assert.ok(logs.some((l) => l.includes('LOCK_BUSY')));
  assert.equal(x.entries().length, 0);
  x.b.lock.allow = true;
  assert.equal(plain(x.b.g.processInbox()).created, 1, '下次拿到锁时照常整理');
});

test('installTriggers：安装每日清理和每 5 分钟整理收件箱两个定时器；重复运行不会装两份，也不动别的定时器', () => {
  const b = createBackend();
  b.scriptApp.newTrigger('somethingElse').timeBased().everyDays(1).create();
  b.g.installTriggers();
  b.g.installTriggers();
  const specs = b.scriptApp.triggers.map((t) => t.spec);
  assert.equal(specs.filter((s) => s.handler === 'dailyCleanup').length, 1);
  assert.deepEqual(specs.filter((s) => s.handler === 'processInbox'), [{ handler: 'processInbox', everyMinutes: 5 }]);
  assert.equal(specs.filter((s) => s.handler === 'somethingElse').length, 1);
});

// ---------------- 端到端：收件口 doPost → 「收件箱」 → 项目 M ----------------

function e2e() {
  const inboxSs = new FakeSpreadsheet();
  const inbox = loadInbox({ ss: inboxSs, now: new Date().toISOString() });
  const b = createBackend({ props: { INBOX_SPREADSHEET_ID: 'inbox-id' }, spreadsheets: { 'inbox-id': inboxSs } });
  const repo = () => b.g.sheetRepo_(b.ss);
  return { inbox, b, repo, entries: () => repo().list('entries') };
}

test('端到端：收件口写入 → 打开网页即整理成账目；定时任务再整理不会多记；状态页有最后入账时间', () => {
  const x = e2e();
  assert.deepEqual(x.inbox.pay('evt-e2e', { occurred_at_text: '' }), { ok: true });
  const boot = plain(x.b.g.api_bootstrap());
  assert.equal(boot.apple_pay.configured, true);
  assert.equal(boot.apple_pay.error, null);
  assert.ok(boot.apple_pay.last_entry_local);
  const es = x.entries();
  assert.equal(es.length, 1);
  assert.equal(es[0].amount_cents, 1234);
  assert.equal(es[0].merchant, "TRADER JOE'S");
  assert.equal(es[0].channel, 'apple_pay');
  assert.deepEqual(plain(x.b.g.processInbox()), { configured: true, created: 0 });
  assert.deepEqual(x.inbox.pay('evt-e2e'), { ok: true });   // 快捷指令重试
  x.b.g.processInbox();
  assert.equal(x.entries().length, 1);
  assert.equal(x.inbox.txnRows().length, 1);
  // 这一笔在网页上显示为 Apple Pay、未分类
  const list = plain(x.b.g.api_listMonth(es[0].month_ny, 'all'));
  const v = list.days[0].entries[0];
  assert.equal(v.channel_label, 'Apple Pay');
  assert.equal(v.category_name, '未分类');
});

test('端到端：手动运行快捷指令（空金额、空商家）→ 一笔待补全，商家 Apple Pay', () => {
  const x = e2e();
  x.inbox.post({ event_id: 'manual-run', amount_text: '', merchant_text: '', occurred_at_text: '' });
  x.b.g.processInbox();
  const e = x.entries()[0];
  assert.equal(e.amount_cents, null);
  assert.equal(e.merchant, 'Apple Pay');
  assert.equal(plain(x.b.g.api_bootstrap()).banner.pending, 1);
});

test('端到端：打开网页时 15 秒内刚整理过就不再整理，定时任务不受影响', () => {
  const x = e2e();
  x.b.g.api_bootstrap();
  x.inbox.pay('evt-later');
  x.b.g.api_bootstrap();                  // 刚刚整理过：跳过
  assert.equal(x.entries().length, 0);
  x.b.g.processInbox();                   // 定时任务：照常整理
  assert.equal(x.entries().length, 1);
});

test('端到端：被限流 → 标记同步到账本、首页红色警告、小助手提示；被拒次数增加时消息更新并重新出现红点', () => {
  const x = e2e();
  for (let i = 1; i <= 10; i++) x.inbox.pay('evt-' + i);
  assert.equal(x.inbox.pay('evt-11').reason, 'rate_limited');
  let boot = plain(x.b.g.api_bootstrap());
  assert.equal(x.entries().length, 10);
  assert.equal(boot.apple_pay.markers.length, 1);
  assert.equal(boot.apple_pay.markers[0].count, 1);
  assert.ok(boot.apple_pay.warnings.some((w) => /拒收了 1 笔/.test(w)));
  let msgs = plain(x.b.g.api_getAssistant()).messages.filter((m) => m.skill_id === 'apple_pay_rate_limited');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /拒收了 1 笔付款.*手动补记/);
  x.b.g.api_markAssistantRead();
  assert.equal(plain(x.b.g.api_bootstrap()).assistant.unread_count, 0);

  // 又被拒 2 次：同一条标记行的被拒次数累加到 3
  x.inbox.pay('evt-12');
  x.inbox.pay('evt-13');
  assert.equal(x.inbox.markerRows().length, 1);
  assert.equal(x.inbox.markerRows()[0].rejected_count, 3);
  x.b.g.processInbox();                          // 定时任务同步标记并运行小助手规则
  boot = plain(x.b.g.api_bootstrap());
  assert.equal(boot.assistant.unread_count, 1, '红点重新出现');
  msgs = plain(x.b.g.api_getAssistant()).messages.filter((m) => m.skill_id === 'apple_pay_rate_limited');
  assert.equal(msgs.length, 1, '仍是同一条消息（更新，不新增）');
  assert.match(msgs[0].text, /拒收了 3 笔/);
  assert.equal(msgs[0].unread, true);
  assert.ok(boot.apple_pay.warnings.some((w) => /拒收了 3 笔/.test(w)));
  // 没有新变化：再运行不会重复提醒
  x.b.g.api_markAssistantRead();
  x.b.g.processInbox();
  assert.equal(plain(x.b.g.api_bootstrap()).assistant.unread_count, 0);
});

test('端到端：每日清理删除收件箱 30 天前的行，保留其余行；账本的 processed_sources 不动', () => {
  const x = e2e();
  const now = Date.now();
  x.inbox.seed('txn', new Date(now - 40 * DAY).toISOString(), 'very-old');
  x.inbox.seed('rate_limited', new Date(now - 35 * DAY).toISOString(), '', 4);
  x.inbox.seed('txn', new Date(now - 31 * DAY).toISOString(), 'old');
  x.inbox.pay('fresh');
  x.b.g.processInbox();
  const keysBefore = plain(x.repo().list('processed_sources').map((p) => p.source_key).sort());
  assert.deepEqual(keysBefore, ['applepay:evt:fresh', 'applepay:evt:old', 'applepay:evt:very-old']);
  x.b.g.dailyCleanup();
  assert.deepEqual(x.inbox.rows().map((r) => r.event_id), ['fresh']);
  assert.deepEqual(plain(x.repo().list('processed_sources').map((p) => p.source_key).sort()), keysBefore);
  assert.deepEqual(x.inbox.sheet().rows[0], Array.from(x.inbox.ctx.INBOX_COLUMNS), '表头还在');
});

test('限流提醒：同一标记只在被拒笔数变多时再提醒', () => {
  const { g } = mSetup();
  const snap = { rate_limited_markers: [{ at: '2026-10-15T15:00:00.000Z', count: 2 }] };
  const first = plain(g.evaluateRateLimited_(snap, {}));
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].upsert, true);
  assert.deepEqual(first.newState, { 'rate_limited_n:2026-10-15T15:00:00.000Z': '2' });
  assert.equal(plain(g.evaluateRateLimited_(snap, first.newState)).messages.length, 0);
  assert.equal(plain(g.evaluateRateLimited_({ rate_limited_markers: [{ at: '2026-10-15T15:00:00.000Z', count: 1 }] }, first.newState)).messages.length, 0, '笔数不会变少；变少时不提醒');
});
