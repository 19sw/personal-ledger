'use strict';
/**
 * 表格读写（store.js）：用假的 Google 表格运行真实的 store.js 代码。
 * 重点：文字不会被表格自动变成日期/数字/公式；金额是整数美分；清理只删除指定的行。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, idGen, plain } = require('./helpers/gas');
const { FakeSpreadsheet } = require('./helpers/fake-sheets');

function setup() {
  const g = loadGas(['store.js']);
  const ss = new FakeSpreadsheet();
  g.ensureLedgerSheets_(ss);
  const repo = () => g.sheetRepo_(ss); // 每次请求新建一个 repo（与 web.js 相同）
  g.svcEnsureDefaults(repo());
  return { g, ss, repo, newId: idGen('row') };
}

test('初始化：创建全部工作表与表头；重复运行安全', () => {
  const { g, ss } = setup();
  for (const t of Object.keys(g.LEDGER_SCHEMA)) {
    assert.deepEqual(ss.getSheetByName(t).rows[0], plain(g.schemaColumnNames(t)), t);
  }
  g.ensureLedgerSheets_(ss);
  assert.equal(ss.getSheetByName('categories').rows.length, 1 + g.DEFAULT_CATEGORIES.length, '表头 + 全部默认类别');
});

test('表头与定义不一致时停止；缺少的新列会补在末尾', () => {
  const { g, ss } = setup();
  ss.getSheetByName('income_sources').rows[0] = ['id', 'archived', 'name'];
  assert.throws(() => g.ensureLedgerSheets_(ss), /第 2 列应为 name/);
  ss.getSheetByName('income_sources').rows[0] = ['id', 'name'];
  g.ensureLedgerSheets_(ss);
  assert.deepEqual(ss.getSheetByName('income_sources').rows[0], ['id', 'name', 'archived']);
});

// 线上账本已经建好的表头（2026-10-15 第五版 setupLedger）。表格按列的位置读写，
// 所以这些列的顺序永远不能变，新列只能加在最后。改了这里 = 线上账本会读错列。
const LIVE_HEADERS = {
  entries: ['id', 'type', 'amount_cents', 'occurred_at', 'month_ny', 'date_ny', 'category_id', 'income_source_id',
    'merchant', 'note', 'channel', 'platform', 'is_refund', 'refund_of', 'flag_dup', 'dup_group',
    'flag_amount_review', 'source_key', 'order_ref', 'created_at', 'updated_at', 'deleted_at'],
  categories: ['id', 'type', 'name', 'sort', 'archived', 'system_key'],
  income_sources: ['id', 'name', 'archived'],
  dup_dismissed: ['pair_key', 'entry_a', 'entry_b'],
  gmail_pending: ['message_id', 'platforms', 'received_at', 'reason', 'reviewed_at', 'created_at']
};

test('线上账本的已有列顺序不变，新列只加在最后；setupLedger 在旧表头末尾补列，旧数据按原列读出', () => {
  const g = loadGas(['store.js']);
  for (const [t, live] of Object.entries(LIVE_HEADERS)) {
    assert.deepEqual(plain(g.schemaColumnNames(t)).slice(0, live.length), live, t + '：已有列的顺序不能变');
  }
  // 模拟线上旧账本：entries 只有旧表头和一行旧数据
  const ss = new FakeSpreadsheet();
  const sh = ss.insertSheet('entries');
  const old = LIVE_HEADERS.entries;
  const row = old.map((c) => ({ id: 'e1', type: 'expense', amount_cents: 1200, created_at: '2026-10-01T12:00:00.000Z',
    updated_at: '2026-10-02T12:00:00.000Z', is_refund: false, flag_dup: false, flag_amount_review: false })[c] ?? '');
  sh.rows.push(old.slice(), row);
  g.ensureLedgerSheets_(ss);
  assert.deepEqual(ss.getSheetByName('entries').rows[0], plain(g.schemaColumnNames('entries')));
  const e = g.sheetRepo_(ss).list('entries')[0];
  assert.equal(e.created_at, '2026-10-01T12:00:00.000Z');
  assert.equal(e.updated_at, '2026-10-02T12:00:00.000Z');
  assert.equal(e.deleted_at, null, '没有被误读成已删除');
  assert.equal(e.restaurant_key, null);
});

test('写入再读出：月份、时间、数字样式的文字保持为文字；金额为整数美分', () => {
  const { g, ss, repo, newId } = setup();
  const now = new Date('2026-02-20T15:00:00Z');
  const cat = repo().list('categories').find((c) => c.name === '兼职').id;
  const saved = g.svcSaveEntry(repo(), {
    type: 'income', amount: '1,234.56', category_id: cat, local_datetime: '2026-01-31T23:30',
    new_source_name: '2026', merchant: '=HYPERLINK("http://x")', note: "'quoted"
  }, now, newId);
  const raw = ss.getSheetByName('entries').rows[1];
  assert.ok(raw.every((v) => !(v instanceof Date)), '没有任何格子被变成日期');
  const back = repo().list('entries')[0];
  assert.equal(back.amount_cents, 123456);
  assert.equal(back.month_ny, '2026-01');
  assert.equal(back.date_ny, '2026-01-31');
  assert.equal(back.occurred_at, '2026-02-01T04:30:00.000Z');
  assert.equal(back.merchant, '=HYPERLINK("http://x")', '公式文字按原样保存为文字');
  assert.equal(back.note, "'quoted");
  assert.equal(back.is_refund, false);
  assert.equal(back.deleted_at, null);
  assert.equal(back.refund_of, null);
  assert.equal(repo().list('income_sources')[0].name, '2026', '数字样式的来源名仍是文字');
  assert.equal(saved.source_name, '2026');
  // 公式文字在表格中以单引号开头写入（不会被执行）
  assert.equal(typeof raw[g.schemaColumnNames('entries').indexOf('merchant')], 'string');
});

test('金额为空（待补全）读出为 null；布尔值正确；更新只改对应行', () => {
  const { g, repo } = setup();
  const r = repo();
  r.insert('entries', { id: 'a', type: 'expense', amount_cents: null, occurred_at: '2026-01-01T00:00:00.000Z', month_ny: '2025-12', date_ny: '2025-12-31', category_id: 'exp_dining', channel: 'apple_pay', flag_dup: true });
  r.insert('entries', { id: 'b', type: 'expense', amount_cents: -2000, occurred_at: '2026-01-02T00:00:00.000Z', month_ny: '2026-01', date_ny: '2026-01-01', category_id: 'exp_dining', channel: 'manual', is_refund: true });
  repo().update('entries', 'a', { amount_cents: 500 });
  const rows = repo().list('entries');
  assert.equal(rows[0].amount_cents, 500);
  assert.equal(rows[0].flag_dup, true);
  assert.equal(rows[0].month_ny, '2025-12');
  assert.equal(rows[1].amount_cents, -2000);
  assert.equal(rows[1].is_refund, true);
  assert.throws(() => repo().insert('entries', { id: 'c', amount_cents: 12.5 }), /非整数/);
  assert.throws(() => repo().update('entries', 'zzz', {}), /找不到/);
});

test('完整流程（表格版）：删除 → 30 天后清理只删除那一行', () => {
  const { g, ss, repo, newId } = setup();
  const cat = repo().list('categories').find((c) => c.name === '餐饮').id;
  const t0 = new Date('2026-01-01T12:00:00Z');
  const ids = ['1', '2', '3'].map((a) => g.svcSaveEntry(repo(), { type: 'expense', amount: a, category_id: cat, local_datetime: '2026-01-01T10:00' }, t0, newId).id);
  g.svcDeleteEntry(repo(), ids[1], t0);
  assert.equal(g.svcPurgeDeleted(repo(), new Date('2026-01-15T00:00:00Z')).purged, 0);
  assert.equal(g.svcPurgeDeleted(repo(), new Date('2026-02-01T00:00:00Z')).purged, 1);
  assert.deepEqual(plain(repo().list('entries')).map((e) => e.id), [ids[0], ids[2]]);
  assert.equal(ss.getSheetByName('entries').rows.length, 3);
  const rep = g.svcGetReport(repo(), '2026-01', new Date('2026-02-01T00:00:00Z'));
  assert.equal(rep.expense.total_cents, 400);
});

// ---------- Task 05：budgets / settings 两张新表 ----------
const { createBackend } = require('./helpers/harness');

/** 后来新增的工作表（Task 05 + Task 06）。线上账本在重新运行 setupLedger 之前都没有。 */
const NEW_SHEETS = ['budgets', 'settings', 'checkins', 'assistant_messages', 'assistant_state'];

/** 模拟“升级前”的线上账本：有旧工作表和数据，但没有 budgets / settings / checkins / assistant_*。 */
function legacyBackend() {
  const b = createBackend();
  const { g, ss } = b;
  g.api_saveEntry({ type: 'expense', amount: '12.34', category_id: 'exp_dining', local_datetime: '2026-01-05T12:00', merchant: '午饭' });
  g.api_saveEntry({ type: 'income', amount: '800', category_id: 'inc_parttime', local_datetime: '2026-01-06T09:00', new_source_name: '兼职 A' });
  for (const n of NEW_SHEETS) delete ss.sheets[n];
  return b;
}
const snapshot = (ss) => JSON.stringify(Object.keys(ss.sheets).sort().map((n) => [n, ss.sheets[n].rows]));

test('setupLedger 在已有账本上重新运行：建好 budgets / settings，旧工作表和数据一点不变；再运行一次也不变', () => {
  const { g, ss } = legacyBackend();
  const before = {};
  for (const n of Object.keys(ss.sheets)) before[n] = JSON.stringify(ss.sheets[n].rows);
  g.setupLedger();
  for (const n of Object.keys(before)) assert.equal(JSON.stringify(ss.sheets[n].rows), before[n], n + ' 未被改动');
  assert.deepEqual(plain(ss.getSheetByName('budgets').rows), [plain(g.schemaColumnNames('budgets'))]);
  assert.deepEqual(plain(ss.getSheetByName('settings').rows), [['key', 'value'], ['budget_near_pct', '80']]);
  assert.equal(ss.getSheetByName('budgets').frozen, 1);
  const once = snapshot(ss);
  g.setupLedger();
  assert.equal(snapshot(ss), once, '重复运行不改变任何内容');
});

test('新表不存在时：打开网页、预算页、月报、账单都不写表格也不建表；设置预算给出中文提示', () => {
  const { g, ss } = legacyBackend();
  const before = snapshot(ss);
  const boot = g.api_bootstrap();
  assert.equal(boot.budget_ready, false);
  assert.equal(boot.budget_near_pct, 80);
  assert.equal(g.api_getBudgets(boot.current_month).total, null);
  assert.equal(g.api_getReport('2026-01').budget, null);
  g.api_getMonthBills('2026');
  g.api_getYearBills();
  assert.equal(snapshot(ss), before, '没有任何写入');
  assert.throws(() => g.api_setBudget('total', '100'), /请先在脚本编辑器里重新运行一次 setupLedger/);
  assert.throws(() => g.api_setBudgetNearPct(90), /setupLedger/);
  assert.equal(ss.getSheetByName('budgets'), null);
  // 重新运行 setupLedger 后即可设置
  g.setupLedger();
  assert.equal(g.api_setBudget('total', '100').total.budget_cents, 10000);
});

test('预算写入表格再读出：月份保持为文字，金额为整数美分，取消行金额为空', () => {
  const { g, ss } = createBackend();
  const month = g.api_bootstrap().current_month;
  g.api_setBudget('total', '1,500.50');
  g.api_setBudget('exp_dining', '200');
  g.api_archiveCategory('exp_dining');
  const raw = ss.getSheetByName('budgets').rows.slice(1);
  assert.ok(raw.every((r) => r.every((v) => !(v instanceof Date))), '没有格子被变成日期');
  const rows = g.sheetRepo_(ss).list('budgets');
  assert.deepEqual(plain(rows.map((r) => [r.scope, r.amount_cents, r.effective_from])),
    [['total', 150050, month], ['exp_dining', null, month]], '同月归档：把本月那一行改为空');
  g.api_setBudgetNearPct(65);
  assert.equal(g.sheetRepo_(ss).list('settings')[0].value, '65');
  assert.equal(g.api_getBudgets(month).near_pct, 65);
});

// ---------- Task 06：checkins / assistant_messages / assistant_state ----------

/** 升级前的账本，账目分布在几个不同的创建日期（含一笔已删除的） */
function legacyWithHistory() {
  const b = createBackend();
  const { g, ss } = b;
  const repo = g.sheetRepo_(ss);
  const add = (id, created, extra = {}) => repo.insert('entries', Object.assign({
    id, type: 'expense', amount_cents: 500, occurred_at: '2026-08-30T16:00:00.000Z', month_ny: '2026-08', date_ny: '2026-08-30',
    category_id: 'exp_dining', merchant: '午饭', note: '', channel: 'manual', is_refund: false, flag_dup: false, flag_amount_review: false,
    created_at: created, updated_at: created, deleted_at: null
  }, extra));
  add('h1', '2026-09-01T03:30:00.000Z');                                   // 费城 8 月 31 日 23:30
  add('h2', '2026-09-02T15:00:00.000Z');
  add('h3', '2026-09-02T13:00:00.000Z');                                   // 同一天更早
  add('h4', '2026-09-05T15:00:00.000Z', { deleted_at: new Date().toISOString() });   // 刚删除：每日清理不会清掉它
  for (const n of NEW_SHEETS) delete ss.sheets[n];
  return b;
}

test('Task 06：升级前的账本 —— 打开网页、小助手、提问、标已读、每日清理都不写表也不建表；保存账目正常', () => {
  const { g, ss } = legacyWithHistory();
  const before = snapshot(ss);
  const boot = g.api_bootstrap();
  assert.deepEqual(plain(boot.assistant), { ready: false, unread_count: 0 });
  assert.equal(boot.checkin.ready, false);
  assert.equal(g.api_getAssistant().ready, false);
  assert.ok(g.api_askAssistant('q_month_to_date').text);
  assert.deepEqual(plain(g.api_markAssistantRead()), { unread_count: 0, marked: 0 });
  const realLog = console.log;
  console.log = () => {};
  try { g.dailyCleanup(); } finally { console.log = realLog; }
  assert.equal(snapshot(ss), before, '没有任何写入');
  const e = g.api_saveEntry({ type: 'expense', amount: '3', category_id: 'exp_dining', local_datetime: '2026-09-10T12:00' });
  assert.equal(e.amount_cents, 300);
  for (const n of NEW_SHEETS) assert.equal(ss.getSheetByName(n), null, n + ' 没有被网页创建');
});

test('Task 06：setupLedger 重新运行 —— 建好 checkins / assistant_* 表，按创建时间补打卡；旧数据一点不变；再运行一次也不变', () => {
  const { g, ss } = legacyWithHistory();
  const before = {};
  for (const n of Object.keys(ss.sheets)) before[n] = JSON.stringify(ss.sheets[n].rows);
  const realLog = console.log;
  console.log = () => {};
  try { g.setupLedger(); } finally { console.log = realLog; }
  for (const n of Object.keys(before)) assert.equal(JSON.stringify(ss.sheets[n].rows), before[n], n + ' 未被改动');
  assert.deepEqual(plain(ss.getSheetByName('assistant_messages').rows), [plain(g.schemaColumnNames('assistant_messages'))]);
  assert.deepEqual(plain(ss.getSheetByName('assistant_state').rows), [['state_key', 'value', 'updated_at']]);
  assert.equal(ss.getSheetByName('checkins').frozen, 1);
  const created = g.sheetRepo_(ss).list('entries').map((e) => e.created_at);
  const today = created.filter((c) => !c.startsWith('2026-09')).map((c) => g.dateNY(c));
  const expected = [['date_ny', 'first_entry_at'],
    ['2026-08-31', '2026-09-01T03:30:00.000Z'], ['2026-09-02', '2026-09-02T13:00:00.000Z'], ['2026-09-05', '2026-09-05T15:00:00.000Z']];
  const rows = plain(ss.getSheetByName('checkins').rows);
  assert.deepEqual(rows.slice(0, 4), expected, '补打卡：费城日期、每天最早的创建时间、已删除账目也算');
  assert.ok(rows.every((r) => r.every((v) => typeof v === 'string')), '日期保持为文字');
  assert.equal(rows.length, 4 + new Set(today).size);
  const once = snapshot(ss);
  console.log = () => {};
  try { g.setupLedger(); } finally { console.log = realLog; }
  assert.equal(snapshot(ss), once, '重复运行不改变任何内容');
  // 之后打开网页：规则开始运行，发出最高的打卡里程碑（4 或 5 天 → 3 天）
  const boot = g.api_bootstrap();
  assert.equal(boot.assistant.ready, true);
  assert.equal(boot.checkin.cumulative, rows.length - 1);
  const ms = g.sheetRepo_(ss).list('assistant_messages').filter((m) => m.skill_id === 'checkin_milestone');
  assert.deepEqual(plain(ms.map((m) => m.dedup_key)), ['checkin:3']);
  g.api_bootstrap();
  assert.equal(g.sheetRepo_(ss).list('assistant_messages').filter((m) => m.skill_id === 'checkin_milestone').length, 1, '再打开不重复');
});

test('Task 06：小助手消息写入表格再读出（items_json、read_at）；标已读只改 read_at', () => {
  const { g, ss } = createBackend();
  g.api_setBudget('total', '10');
  g.api_saveEntry({ type: 'expense', amount: '9', category_id: 'exp_dining', local_datetime: g.api_bootstrap().now_local });
  const a = g.api_getAssistant();
  assert.ok(a.unread_count >= 2);
  const near = a.messages.find((m) => m.skill_id === 'budget_near');
  assert.deepEqual(plain(near.items), [{ label: '预算', amount_cents: 1000 }, { label: '已用', amount_cents: 900 }]);
  assert.ok(a.messages.some((m) => m.skill_id === 'checkin_milestone' && m.mood === 'happy'));
  const raw = ss.getSheetByName('assistant_messages').rows.slice(1);
  assert.ok(raw.every((r) => r.every((v) => !(v instanceof Date))), '没有格子被变成日期');
  const textBefore = raw.map((r) => r.slice(0, 7));
  assert.equal(g.api_markAssistantRead().marked, a.unread_count);
  assert.equal(g.api_bootstrap().assistant.unread_count, 0);
  assert.deepEqual(ss.getSheetByName('assistant_messages').rows.slice(1).map((r) => r.slice(0, 7)), textBefore);
  assert.ok(g.api_getAssistant().messages.every((m) => !m.unread));
});

test('一次性修复 repairEntryColumns20261026：只改名单里仍是错位样子的 6 行；修好后不再显示为已删除；重复运行不再改', () => {
  const { g, ss } = createBackend();
  const sh = ss.getSheetByName('entries');
  const names = g.schemaColumnNames('entries');
  const ids = g.ENTRY_COLUMN_REPAIRS_20261026.map((t) => t.id);
  const make = (id, cells) => names.map((n) => (Object.prototype.hasOwnProperty.call(cells, n) ? cells[n] : ({
    id, type: 'expense', amount_cents: 810, occurred_at: '2026-10-23T01:32:43.357Z', month_ny: '2026-10', date_ny: '2026-10-22',
    category_id: 'exp_other', channel: 'apple_pay', is_refund: false, flag_dup: false, flag_amount_review: false, source_key: 'applepay:evt:' + id
  })[n] ?? ''));
  const t1 = '2026-10-23T01:33:56.981Z';
  // 线上看到的样子：第 2 行 = W 多写了值的已删除测试账目；第 3–7 行 = 错位行；第 8 行 = 不在名单里的同样错位行；第 9 行 = 正常行
  sh.rows.push(make(ids[0], { created_at: '2026-10-15T20:17:15.314Z', updated_at: '2026-10-15T21:43:26.999Z',
    deleted_at: '2026-10-22T23:48:03.724Z', restaurant_key: '2026-10-22T23:48:03.724Z' }));
  for (const id of ids.slice(1)) sh.rows.push(make(id, { created_at: '', updated_at: t1, deleted_at: t1, restaurant_key: '' }));
  sh.rows.push(make('not-in-list', { created_at: '', updated_at: t1, deleted_at: t1, restaurant_key: '' }));
  sh.rows.push(make('normal-row', { created_at: t1, updated_at: t1, deleted_at: '', restaurant_key: '' }));
  const before = JSON.parse(JSON.stringify(sh.rows));

  assert.deepEqual(plain(g.repairEntryColumns20261026()), { fixed: 6, skipped: 0, missing: 0 });
  const byId = Object.fromEntries(g.sheetRepo_(ss).list('entries').map((e) => [e.id, e]));
  assert.equal(byId[ids[0]].deleted_at, '2026-10-22T23:48:03.724Z', '测试账目仍是已删除');
  assert.equal(byId[ids[0]].restaurant_key, null, 'W 清空');
  assert.equal(byId[ids[0]].created_at, '2026-10-15T20:17:15.314Z');
  for (const id of ids.slice(1)) {
    assert.deepEqual([byId[id].created_at, byId[id].updated_at, byId[id].deleted_at], [t1, t1, null], id);
    assert.equal(typeof sh.rows.find((r) => r[0] === id)[names.indexOf('created_at')], 'string', '写成文字，没被变成日期');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sh.rows.find((r) => r[0] === 'not-in-list'))), before.find((r) => r[0] === 'not-in-list'), '名单外的行不碰');
  assert.deepEqual(JSON.parse(JSON.stringify(sh.rows.find((r) => r[0] === 'normal-row'))), before.find((r) => r[0] === 'normal-row'));
  assert.deepEqual(JSON.parse(JSON.stringify(sh.rows[0])), before[0], '表头不变');
  // 修好的账目回到账目列表
  const listed = g.api_listMonth('2026-10', 'all').days.flatMap((d) => d.entries).map((e) => e.id);
  for (const id of ids.slice(1)) assert.ok(listed.includes(id), id + ' 出现在账目列表');

  const after = JSON.parse(JSON.stringify(sh.rows));
  assert.deepEqual(plain(g.repairEntryColumns20261026()), { fixed: 0, skipped: 6, missing: 0 }, '重复运行不再改');
  assert.deepEqual(JSON.parse(JSON.stringify(sh.rows)), after);
});

test('一次性修复：表头和程序不一致时什么都不改', () => {
  const { g, ss } = createBackend();
  const sh = ss.getSheetByName('entries');
  sh.rows[0] = sh.rows[0].slice(0, -1);   // 还没补上 restaurant_key 列
  const before = JSON.parse(JSON.stringify(sh.rows));
  assert.throws(() => g.repairEntryColumns20261026(), /setupLedger/);
  assert.deepEqual(JSON.parse(JSON.stringify(sh.rows)), before);
});
