'use strict';
/** 账本规则：状态优先级、来源去重、输入校验、软删除与 30 天清理、退款关联、类别保护。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { plain, loadGas, memoryRepo } = require('./helpers/gas');

const EXPENSE_NAMES = ['餐饮', '购物', '交通', '住房', '日用', '娱乐', '蔬菜', '水果', '零食', '咖啡奶茶', '买菜', '服饰', '美容', '医疗', '运动',
  '旅行', '通讯', '订阅会员', '学习', '书籍', '数码', '宠物', '礼物', '社交', '其他', '未分类'];
const INCOME_NAMES = ['工资', '兼职', '奖金', '红包礼金', '报销', '退税', '利息', '其他'];

test('状态优先级：待补全 > 待核对金额 > 待核对重复 > 正常', () => {
  const { g } = setup();
  assert.equal(g.entryStatus({ amount_cents: null, flag_amount_review: true, flag_dup: true }), 'pending');
  assert.equal(g.entryStatus({ amount_cents: 100, flag_amount_review: true, flag_dup: true }), 'amount_review');
  assert.equal(g.entryStatus({ amount_cents: 100, flag_amount_review: false, flag_dup: true }), 'dup_review');
  assert.equal(g.entryStatus({ amount_cents: 0 + 100, flag_amount_review: false, flag_dup: false }), 'normal');
  assert.equal(g.entryStatus({ amount_cents: -2000 }), 'normal', '退款（负数）不是待补全');
});

test('首页提示条：只统计本月未删除的账目，待核对 = 金额 + 重复', () => {
  const { g } = setup();
  const es = [
    { month_ny: '2026-01', amount_cents: null },
    { month_ny: '2026-01', amount_cents: 1, flag_dup: true },
    { month_ny: '2026-01', amount_cents: 1, flag_amount_review: true },
    { month_ny: '2026-01', amount_cents: null, flag_dup: true },
    { month_ny: '2026-01', amount_cents: null, deleted_at: '2026-01-05T00:00:00Z' },
    { month_ny: '2026-02', amount_cents: null }
  ];
  assert.deepEqual(plain(g.bannerCounts(es, '2026-01')), { pending: 2, review: 2 });
});

test('收入来源：名称去首尾空格、不区分大小写，重复时复用已有来源', () => {
  const t = setup();
  const a = t.income('10', '兼职', '2026-01-01T10:00', { new_source_name: '兼职 A' });
  const a2 = t.income('20', '兼职', '2026-01-02T10:00', { new_source_name: '  兼职   a ' });
  assert.equal(a2.income_source_id, a.income_source_id);
  assert.equal(t.repo.list('income_sources').length, 1);
  const viaApi = t.g.svcAddSource(t.repo, 'ＡＢＣ', t.newId);
  assert.equal(t.g.svcAddSource(t.repo, 'abc', t.newId).id, viaApi.id, '全角/半角、大小写视为同名');
  assert.throws(() => t.g.svcAddSource(t.repo, '   ', t.newId), /不能为空/);
  // 停用后再次输入同名 → 重新启用，而不是新建
  t.g.svcArchiveSource(t.repo, a.income_source_id);
  const again = t.income('5', '兼职', '2026-01-03T10:00', { new_source_name: '兼职 A' });
  assert.equal(again.income_source_id, a.income_source_id);
  assert.equal(t.repo.list('income_sources').find((s) => s.id === a.income_source_id).archived, false);
  assert.equal(t.repo.list('income_sources').length, 2);
});

test('手动录入校验：金额必填且大于 0；类别类型一致；支出不带来源', () => {
  const t = setup();
  const base = { type: 'expense', category_id: t.cat('餐饮'), local_datetime: '2026-01-01T10:00' };
  assert.throws(() => t.save(Object.assign({}, base, { amount: '' })), /金额必填/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: '0' })), /大于 0/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: '-5' })), /大于 0/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: 'abc' })), /格式/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: '5', category_id: t.cat('工资', 'income') })), /不一致/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: '5', category_id: '' })), /请选择类别/);
  assert.throws(() => t.save(Object.assign({}, base, { amount: '5', type: 'transfer' })), /支出或收入/);
  const e = t.save(Object.assign({}, base, { amount: '5', income_source_id: 'whatever' }));
  assert.equal(e.income_source_id, null);
  assert.equal(e.channel, 'manual');
  assert.equal(t.repo.list('entries').length, 1, '失败的提交不会写入任何账目');
});

test('自动记录：渠道不可改；未补全时可以只改其他字段；已有金额不能清空', () => {
  const t = setup();
  const p = t.autoPending('未分类', '2026-01-12T12:00');
  const edited = t.save({ id: p.id, type: 'income', amount: '', category_id: t.cat('餐饮'), local_datetime: '2026-01-12T12:00', channel: 'manual' });
  assert.equal(edited.type, 'expense', '自动记录的类型不可改');
  assert.equal(edited.channel, 'apple_pay');
  assert.equal(edited.amount_cents, null);
  assert.equal(edited.category_name, '餐饮');
  const filled = t.save({ id: p.id, amount: '7.5', category_id: t.cat('餐饮'), local_datetime: '2026-01-12T12:00' });
  assert.equal(filled.amount_cents, 750);
  assert.throws(() => t.save({ id: p.id, amount: '', category_id: t.cat('餐饮'), local_datetime: '2026-01-12T12:00' }), /不能清空/);
  const raw = t.repo.list('entries').find((e) => e.id === p.id);
  assert.match(raw.source_key, /^applepay:evt:/, '来源凭据保持不变');
});

test('修改日期跨月：账目移到新月份，前后两个月的“最后更新时间”都会更新', () => {
  const t = setup();
  const e = t.expense('10', '餐饮', '2026-01-31T23:30');
  t.setNow('2026-02-15T15:00:00Z');
  const moved = t.save({ id: e.id, type: 'expense', amount: '10', category_id: t.cat('餐饮'), local_datetime: '2026-02-01T00:30' });
  assert.equal(moved.month_ny, '2026-02');
  const meta = Object.fromEntries(t.repo.list('month_meta').map((m) => [m.month, m.last_changed_at]));
  assert.equal(meta['2026-01'], '2026-02-15T15:00:00.000Z');
  assert.equal(meta['2026-02'], '2026-02-15T15:00:00.000Z');
});

test('软删除：不计入统计、可恢复并回到原月份；删除的账目不能编辑', () => {
  const t = setup();
  const e = t.expense('30', '餐饮', '2026-01-15T12:00');
  t.g.svcDeleteEntry(t.repo, e.id, t.now());
  assert.equal(t.report('2026-01').expense.total_cents, 0);
  assert.equal(t.g.svcListMonth(t.repo, '2026-01').days.length, 0);
  assert.equal(t.repo.list('entries').length, 1, '行仍在表中（软删除）');
  const deleted = t.g.svcListDeleted(t.repo);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].purge_on, '2026-03-22', '删除时间 2026-02-20 + 30 天');
  assert.throws(() => t.save({ id: e.id, type: 'expense', amount: '1', category_id: t.cat('餐饮'), local_datetime: '2026-01-15T12:00' }), /已删除/);
  assert.throws(() => t.g.svcDeleteEntry(t.repo, e.id, t.now()), /已经删除/);
  const restored = t.g.svcRestoreEntry(t.repo, e.id, t.now());
  assert.equal(restored.month_ny, '2026-01');
  assert.equal(t.report('2026-01').expense.total_cents, 3000);
  assert.throws(() => t.g.svcRestoreEntry(t.repo, e.id, t.now()), /没有被删除/);
});

test('30 天清理：只彻底删除“已删除超过 30 天”的行；未删除的账目永远不会被清理', () => {
  const t = setup('2026-01-01T12:00:00Z');
  const live = t.expense('1', '餐饮', '2025-11-01T12:00');
  const old = t.expense('2', '餐饮', '2025-11-02T12:00');
  const recent = t.expense('3', '餐饮', '2025-11-03T12:00');
  t.g.svcDeleteEntry(t.repo, old.id, new Date('2026-01-01T12:00:00Z'));
  t.g.svcDeleteEntry(t.repo, recent.id, new Date('2026-01-20T12:00:00Z'));
  t.repo.insert('processed_sources', { source_key: 'gmail:msg:x', entry_id: old.id, outcome: 'created', processed_at: '2026-01-01T00:00:00Z' });

  // 恰好 30 天：还不清除
  let res = t.g.svcPurgeDeleted(t.repo, new Date('2026-01-31T12:00:00Z'));
  assert.equal(res.purged, 0);
  res = t.g.svcPurgeDeleted(t.repo, new Date('2026-01-31T12:00:01Z'));
  assert.equal(res.purged, 1);
  const ids = t.repo.list('entries').map((e) => e.id);
  assert.deepEqual(ids.sort(), [live.id, recent.id].sort());
  assert.equal(t.repo.list('processed_sources').length, 1, '去重凭据不清理');

  // 删除时间无法识别的行不清理（宁可多留）
  t.repo.update('entries', recent.id, { deleted_at: 'not-a-date' });
  assert.equal(t.g.svcPurgeDeleted(t.repo, new Date('2030-01-01T00:00:00Z')).purged, 0);
  assert.ok(t.repo.list('entries').some((e) => e.id === live.id));
});

test('退款关联：只能关联未删除的普通支出；原交易删除后退款仍计入', () => {
  const t = setup();
  const orig = t.expense('120', '餐饮', '2026-01-10T12:00', { merchant: 'Shop' });
  const income = t.income('50', '工资', '2026-01-10T12:00');
  const r1 = t.save({ type: 'expense', is_refund: true, refund_of: orig.id, amount: '20', local_datetime: '2026-02-03T10:00' });
  assert.throws(() => t.save({ type: 'expense', is_refund: true, refund_of: r1.id, amount: '1', local_datetime: '2026-02-03T10:00' }), /普通支出/);
  assert.throws(() => t.save({ type: 'expense', is_refund: true, refund_of: income.id, amount: '1', local_datetime: '2026-02-03T10:00' }), /普通支出/);
  assert.throws(() => t.save({ type: 'expense', is_refund: true, refund_of: 'nope', amount: '1', local_datetime: '2026-02-03T10:00', category_id: t.cat('餐饮') }), /找不到/);
  // 不关联原交易的退款也可以（PRD：可选择关联）
  const free = t.save({ type: 'expense', is_refund: true, amount: '3', category_id: t.cat('购物'), local_datetime: '2026-02-04T10:00' });
  assert.equal(free.amount_cents, -300);
  assert.equal(free.refund_of, null);
  // 收入不能是退款
  const inc = t.save({ type: 'income', is_refund: true, amount: '3', category_id: t.cat('工资', 'income'), local_datetime: '2026-02-04T10:00' });
  assert.equal(inc.is_refund, false);
  assert.equal(inc.amount_cents, 300);
  // 原交易删除：退款仍计入 2 月，标签提示原交易已删除
  t.g.svcDeleteEntry(t.repo, orig.id, t.now());
  assert.equal(t.report('2026-02').expense.total_cents, -2300);
  assert.match(t.g.svcGetEntry(t.repo, r1.id).refund_of_label, /原交易已删除/);
  // 原交易被彻底清除后
  t.g.svcPurgeDeleted(t.repo, new Date(t.now().getTime() + 31 * 86400000));
  assert.equal(t.g.svcGetEntry(t.repo, r1.id).refund_of_label, '原交易已清除');
  // 取消“这是退款”后金额变回正数、关联清空
  const un = t.save({ id: free.id, type: 'expense', is_refund: false, amount: '3', category_id: t.cat('购物'), local_datetime: '2026-02-04T10:00' });
  assert.equal(un.amount_cents, 300);
  assert.equal(un.is_refund, false);
});

test('退款候选：只列出最近 365 天、未删除、有金额的普通支出', () => {
  const t = setup('2026-06-01T12:00:00Z');
  const recent = t.expense('10', '餐饮', '2026-05-01T12:00');
  t.expense('10', '餐饮', '2025-05-01T12:00');
  t.autoPending('餐饮', '2026-05-02T12:00');
  t.save({ type: 'expense', is_refund: true, refund_of: recent.id, amount: '1', local_datetime: '2026-05-03T10:00' });
  const ids = plain(t.g.svcRefundCandidates(t.repo, t.now())).map((e) => e.id);
  assert.deepEqual(ids, [recent.id]);
});

test('默认类别与“未分类”保护（D9）；删除类别 = 归档，历史账目不受影响', () => {
  const t = setup();
  const cats = t.repo.list('categories');
  assert.deepEqual(cats.filter((c) => c.type === 'expense').map((c) => c.name), EXPENSE_NAMES);
  assert.deepEqual(cats.filter((c) => c.type === 'income').map((c) => c.name), INCOME_NAMES);
  assert.throws(() => t.g.svcArchiveCategory(t.repo, t.cat('未分类'), t.now(), t.newId), /系统类别/);
  t.g.svcEnsureDefaults(t.repo);
  assert.equal(t.repo.list('categories').length, EXPENSE_NAMES.length + INCOME_NAMES.length, '重复初始化不会重复写入');

  const e = t.expense('10', '娱乐', '2026-01-01T10:00');
  t.g.svcArchiveCategory(t.repo, t.cat('娱乐'), t.now(), t.newId);
  assert.equal(t.report('2026-01').expense.rows[0].name, '娱乐', '月报仍显示已归档类别');
  assert.throws(() => t.expense('1', '娱乐', '2026-01-02T10:00'), /已删除/);
  // 编辑一笔原本就在已归档类别里的账目，仍可保存
  const ok = t.save({ id: e.id, type: 'expense', amount: '11', category_id: t.cat('娱乐'), local_datetime: '2026-01-01T10:00' });
  assert.equal(ok.amount_cents, 1100);
  // 新增同名类别 → 重新启用
  const back = t.g.svcAddCategory(t.repo, 'expense', '娱乐', t.newId);
  assert.equal(back.id, t.cat('娱乐'));
  assert.equal(back.archived, false);
  assert.throws(() => t.g.svcAddCategory(t.repo, 'expense', '餐饮', t.newId), /同名/);
  const added = t.g.svcAddCategory(t.repo, 'income', '奖学金', t.newId);
  assert.equal(added.type, 'income');
  assert.equal(added.sort, Math.max(...t.repo.list('categories').map((c) => c.sort)), '新建类别排在最后');
});

test('账目页：按日期倒序分组，每天显示支出小计（退款为负、收入和待补全不计）', () => {
  const t = setup();
  t.expense('10', '餐饮', '2026-01-05T09:00');
  t.expense('5.5', '日用', '2026-01-05T18:00');
  t.income('100', '工资', '2026-01-05T10:00');
  const o = t.expense('20', '购物', '2026-01-07T09:00');
  t.save({ type: 'expense', is_refund: true, refund_of: o.id, amount: '4', local_datetime: '2026-01-07T19:00' });
  t.autoPending('未分类', '2026-01-07T12:00');
  const list = t.g.svcListMonth(t.repo, '2026-01');
  assert.deepEqual(plain(list.days).map((d) => [d.date, d.expense_subtotal_cents, d.entries.length]),
    [['2026-01-07', 1600, 3], ['2026-01-05', 1550, 3]]);
  assert.deepEqual(plain(list.days[0].entries).map((e) => e.local_datetime), ['2026-01-07T19:00', '2026-01-07T12:00', '2026-01-07T09:00']);
  const attention = t.g.svcListMonth(t.repo, '2026-01', 'attention');
  assert.equal(attention.days.flatMap((d) => d.entries).length, 1);
  assert.throws(() => t.g.svcListMonth(t.repo, '2026-1'), /月份/);
});

test('验收辅助：测试用待补全账目归入“未分类”、金额为空、可被补填', () => {
  const t = setup();
  const e = t.g.svcInsertTestPending(t.repo, '2026-01-31T23:30', t.now(), t.newId);
  assert.equal(e.status, 'pending');
  assert.equal(e.category_name, '未分类');
  assert.equal(e.month_ny, '2026-01');
  assert.equal(t.report('2026-01').pending_count, 1);
  const f = t.save({ id: e.id, amount: '50', category_id: e.category_id, local_datetime: e.local_datetime });
  assert.equal(f.status, 'normal');
});

test('账目只读展示将自动渠道显示为来源标签，但保留存储类别', () => {
  const t = setup();
  const apple = t.autoPending('未分类', '2026-01-12T12:00');
  const appleView = t.g.svcGetEntry(t.repo, apple.id);
  assert.equal(appleView.category_name, '未分类', '编辑逻辑仍保留真实类别');
  assert.equal(appleView.display_category_name, 'Apple Pay');
  assert.equal(t.repo.list('entries').find((e) => e.id === apple.id).category_id, apple.category_id);

  const now = new Date().toISOString();
  const gmailAt = t.g.parseLocalNY('2026-01-13T12:00');
  t.repo.insert('entries', { id: 'gmail-1', type: 'expense', amount_cents: 2500, occurred_at: gmailAt.toISOString(),
    month_ny: t.g.monthNY(gmailAt), date_ny: t.g.dateNY(gmailAt), category_id: apple.category_id,
    merchant: 'Online shop', channel: 'gmail_receipt', created_at: now, updated_at: now });
  const gmailView = t.g.svcGetEntry(t.repo, 'gmail-1');
  assert.equal(gmailView.display_category_name, 'Online Order');
  assert.equal(gmailView.category_name, '未分类');

  const manual = t.expense('10', '餐饮', '2026-01-14T12:00');
  const manualView = t.g.svcGetEntry(t.repo, manual.id);
  assert.equal(manualView.display_category_name, '餐饮');
});

test('编辑退款：原交易已删除或已被清除时，保留原关联即可保存；改成新的关联仍需校验', () => {
  const t = setup('2026-02-20T15:00:00Z');
  const orig = t.expense('120', '餐饮', '2026-01-10T12:00');
  const other = t.expense('30', '购物', '2026-01-11T12:00');
  const refund = t.save({ type: 'expense', is_refund: true, refund_of: orig.id, amount: '20', local_datetime: '2026-02-03T10:00' });

  // 原交易被软删除后，编辑退款金额
  t.g.svcDeleteEntry(t.repo, orig.id, t.now());
  const edited = t.save({ id: refund.id, type: 'expense', is_refund: true, refund_of: orig.id, amount: '25',
    category_id: refund.category_id, local_datetime: '2026-02-03T10:00' });
  assert.equal(edited.amount_cents, -2500);
  assert.equal(edited.refund_of, orig.id, '关联保留');
  assert.match(edited.refund_of_label, /原交易已删除/);

  // 改成关联另一笔已删除的支出：拒绝
  t.g.svcDeleteEntry(t.repo, other.id, t.now());
  assert.throws(() => t.save({ id: refund.id, type: 'expense', is_refund: true, refund_of: other.id, amount: '25',
    category_id: refund.category_id, local_datetime: '2026-02-03T10:00' }), /找不到要关联的原交易/);

  // 原交易被 30 天清理彻底删除后，仍可编辑退款
  t.setNow('2026-04-01T12:00:00Z');
  assert.equal(t.g.svcPurgeDeleted(t.repo, t.now()).purged, 2);
  const again = t.save({ id: refund.id, type: 'expense', is_refund: true, refund_of: orig.id, amount: '26',
    category_id: refund.category_id, note: '补充说明', local_datetime: '2026-02-03T10:00' });
  assert.equal(again.amount_cents, -2600);
  assert.equal(again.refund_of, orig.id);
  assert.equal(again.refund_of_label, '原交易已清除');
  assert.equal(t.report('2026-02').expense.total_cents, -2600, '退款仍是独立账目，照常计入');
});

test('自动记录的退款（金额未知）在原交易删除后仍可补填金额', () => {
  const t = setup();
  const orig = t.expense('40', '餐饮', '2026-01-10T12:00');
  const p = t.autoPending('餐饮', '2026-01-12T12:00');
  t.repo.update('entries', p.id, { is_refund: true, refund_of: orig.id, channel: 'gmail_receipt', platform: 'doordash' });
  t.g.svcDeleteEntry(t.repo, orig.id, t.now());
  const filled = t.save({ id: p.id, amount: '15', refund_of: orig.id, category_id: p.category_id, local_datetime: '2026-01-12T12:00' });
  assert.equal(filled.amount_cents, -1500);
  assert.equal(filled.refund_of, orig.id);
  assert.equal(filled.channel, 'gmail_receipt');
});

test('dup_dismissed 以 pair_key 为主键（每一对账目一行）', () => {
  const { g } = setup();
  assert.equal(g.LEDGER_SCHEMA.dup_dismissed.key, 'pair_key');
  assert.deepEqual(Array.from(g.schemaColumnNames('dup_dismissed')), ['pair_key', 'entry_a', 'entry_b']);
});

// ---------- svcEnsureDefaults：新账本、旧账本升级、重复运行 ----------

/** 旧版本（升级前）的默认类别：6 个普通 + 其他 + 未分类；收入 工资/兼职/其他，sort 1..11。 */
function legacyLedger() {
  const g = loadGas();
  const repo = memoryRepo(g);
  const old = [
    ['exp_dining', 'expense', '餐饮'], ['exp_shopping', 'expense', '购物'], ['exp_transport', 'expense', '交通'], ['exp_housing', 'expense', '住房'],
    ['exp_daily', 'expense', '日用'], ['exp_entertainment', 'expense', '娱乐'], ['exp_other', 'expense', '其他'], ['exp_uncategorized', 'expense', '未分类'],
    ['inc_salary', 'income', '工资'], ['inc_parttime', 'income', '兼职'], ['inc_other', 'income', '其他']
  ];
  old.forEach(([id, type, name], i) => repo.insert('categories', { id, type, name, sort: i + 1, archived: false, system_key: id === 'exp_uncategorized' ? 'uncategorized' : null }));
  return { g, repo };
}
const namesOf = (repo, type) => repo.list('categories').filter((c) => c.type === type).sort((a, b) => a.sort - b.sort).map((c) => c.name);

test('默认类别：新账本一次写入全部，其他/未分类在最后，id 唯一', () => {
  const g = loadGas();
  const repo = memoryRepo(g);
  g.svcEnsureDefaults(repo);
  assert.deepEqual(namesOf(repo, 'expense'), EXPENSE_NAMES);
  assert.deepEqual(namesOf(repo, 'income'), INCOME_NAMES);
  const ids = repo.list('categories').map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const sorts = repo.list('categories').map((c) => c.sort);
  assert.equal(new Set(sorts).size, sorts.length, 'sort 不重复');
});

test('默认类别：旧账本只补缺少的类别，已有行原样不动，其他/未分类移到最后；重复运行无变化', () => {
  const { g, repo } = legacyLedger();
  const before = repo.list('categories');
  g.svcEnsureDefaults(repo);
  assert.deepEqual(namesOf(repo, 'expense'), EXPENSE_NAMES);
  assert.deepEqual(namesOf(repo, 'income'), INCOME_NAMES);
  const after = repo.list('categories');
  for (const b of before) {
    const a = after.find((c) => c.id === b.id);
    assert.equal(a.name, b.name); assert.equal(a.archived, b.archived); assert.equal(a.type, b.type);
    if (!['exp_other', 'exp_uncategorized', 'inc_other'].includes(b.id)) assert.equal(a.sort, b.sort, b.name + ' 的 sort 不变');
  }
  const snapshot = plain(repo.list('categories'));
  g.svcEnsureDefaults(repo);
  g.svcEnsureDefaults(repo);
  assert.deepEqual(plain(repo.list('categories')), snapshot, '重复运行不产生任何变化');
  assert.equal(after.length, EXPENSE_NAMES.length + INCOME_NAMES.length);
});

test('默认类别：用户已有同名类别（含已停用、大小写不同）时不重复、不重新启用、不改名', () => {
  const { g, repo } = legacyLedger();
  repo.insert('categories', { id: 'u-pet', type: 'expense', name: '宠物', sort: 12, archived: true, system_key: null });
  repo.insert('categories', { id: 'u-gift', type: 'expense', name: ' 礼物 ', sort: 13, archived: false, system_key: null });
  repo.insert('categories', { id: 'u-bonus', type: 'income', name: '奖金', sort: 14, archived: true, system_key: null });
  repo.insert('categories', { id: 'u-latte', type: 'expense', name: 'Coffee', sort: 15, archived: false, system_key: null });
  g.svcEnsureDefaults(repo);
  const cats = repo.list('categories');
  assert.equal(cats.filter((c) => c.type === 'expense' && c.name === '宠物').length, 1);
  assert.equal(cats.find((c) => c.id === 'u-pet').archived, true, '已停用的不会被重新启用');
  assert.equal(cats.filter((c) => c.type === 'expense' && c.name.trim() === '礼物').length, 1);
  assert.equal(cats.find((c) => c.id === 'u-gift').name, ' 礼物 ', '不改名');
  assert.equal(cats.filter((c) => c.type === 'income' && c.name === '奖金').length, 1);
  assert.equal(cats.find((c) => c.id === 'u-bonus').archived, true);
  assert.ok(!cats.some((c) => c.id === 'exp_pets' || c.id === 'exp_gifts' || c.id === 'inc_bonus'), '同名的默认类别没有再建');
  // 同名但类型不同不算重复：收入里没有“宠物”，支出里的“奖金”缺失时仍会补
  assert.ok(cats.some((c) => c.id === 'exp_snacks'));
  // 用户自建类别排在新补的类别之前、其他/未分类之前
  const order = namesOf(repo, 'expense');
  assert.ok(order.indexOf('Coffee') < order.indexOf('其他'));
  assert.deepEqual(order.slice(-2), ['其他', '未分类']);
  const snapshot = plain(repo.list('categories'));
  g.svcEnsureDefaults(repo);
  assert.deepEqual(plain(repo.list('categories')), snapshot);
});

test('默认类别：已有账目引用的类别 id 不变；打开网页（bootstrap）不会补类别', () => {
  const { g, repo } = legacyLedger();
  const now = new Date('2026-02-20T15:00:00Z');
  g.svcBootstrap(repo, now);
  g.svcSeedDefaultsIfEmpty_(repo);
  assert.equal(repo.list('categories').length, 11, '非空账本不会在打开网页时被改动');
  const empty = memoryRepo(g);
  g.svcSeedDefaultsIfEmpty_(empty);
  assert.equal(empty.list('categories').length, EXPENSE_NAMES.length + INCOME_NAMES.length, '完全空的账本才会初始化');
});
