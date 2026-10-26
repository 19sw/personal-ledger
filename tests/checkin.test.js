'use strict';
/**
 * 打卡（Task 06）：按账目创建时间（费城日期）记录；删除/清理不影响；setupLedger 补打卡幂等；
 * 连续/累计/本周/里程碑。数字和日期均为测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers/fixtures');
const { loadGas, plain } = require('./helpers/gas');

const rows = (t) => plain(t.repo.list('checkins'));

test('打卡日期 = 创建时间的费城日期：费城 1 月 31 日 23:30（UTC 已是 2 月 1 日）记在 1 月 31 日；00:30 记在 2 月 1 日', () => {
  const t = setup('2026-02-01T04:30:00Z');            // 费城 1 月 31 日 23:30
  t.expense('12', '餐饮', '2026-01-31T23:00');
  assert.deepEqual(rows(t), [{ date_ny: '2026-01-31', first_entry_at: '2026-02-01T04:30:00.000Z' }]);
  t.setNow('2026-02-01T05:30:00Z');                   // 费城 2 月 1 日 00:30
  t.expense('3', '交通', '2026-02-01T00:20');
  assert.deepEqual(rows(t).map((r) => r.date_ny), ['2026-01-31', '2026-02-01']);
});

test('按创建日期而不是交易日期；同一天多笔只记一行；修改账目不算打卡', () => {
  const t = setup('2026-02-20T15:00:00Z');
  const e = t.expense('12', '餐饮', '2026-01-05T12:00');     // 补记 1 月的账
  t.expense('5', '交通', '2026-02-20T08:00');
  assert.deepEqual(rows(t), [{ date_ny: '2026-02-20', first_entry_at: '2026-02-20T15:00:00.000Z' }]);
  t.setNow('2026-02-22T15:00:00Z');
  t.save({ id: e.id, type: 'expense', amount: '13', category_id: t.cat('餐饮'), local_datetime: '2026-01-05T12:00' });
  assert.equal(rows(t).length, 1, '编辑不是新建，不打卡');
});

test('自动入账也算打卡（模拟的自动记录 svcInsertTestPending 与共用的 svcOnEntryCreated_）', () => {
  const t = setup('2026-03-03T14:00:00Z');
  t.g.svcInsertTestPending(t.repo, '2026-03-01T10:00', t.now(), t.newId);
  assert.deepEqual(rows(t).map((r) => r.date_ny), ['2026-03-03']);
  // 以后的 Gmail / Apple Pay 入账调用同一个函数
  t.g.svcOnEntryCreated_(t.repo, { created_at: '2026-03-05T16:00:00.000Z' });
  assert.deepEqual(rows(t).map((r) => r.date_ny), ['2026-03-03', '2026-03-05']);
});

test('删除、恢复、30 天后彻底清除账目，打卡都保留', () => {
  const t = setup('2026-01-10T15:00:00Z');
  const e = t.expense('12', '餐饮', '2026-01-10T09:00');
  t.g.svcDeleteEntry(t.repo, e.id, t.now());
  assert.equal(rows(t).length, 1);
  const purged = t.g.svcPurgeDeleted(t.repo, new Date('2026-02-20T00:00:00Z'));
  assert.equal(purged.purged, 1);
  assert.equal(t.repo.list('entries').length, 0);
  assert.deepEqual(rows(t).map((r) => r.date_ny), ['2026-01-10'], '清理后打卡仍在');
  assert.equal(t.g.svcCheckinView_(t.repo, new Date('2026-02-20T00:00:00Z')).cumulative, 1);
});

test('补打卡：按已有账目的创建时间（含已删除的）补缺少的天，每天取最早时间；已有行不动；重复运行不变', () => {
  const t = setup('2026-03-10T15:00:00Z');
  const base = { type: 'expense', amount_cents: 100, category_id: 'exp_dining', month_ny: '2026-03', date_ny: '2026-03-01', channel: 'manual' };
  const add = (id, created, extra = {}) => t.repo.insert('entries', Object.assign({ id, created_at: created, occurred_at: '2026-03-01T17:00:00.000Z' }, base, extra));
  add('a', '2026-03-01T20:00:00.000Z');
  add('b', '2026-03-01T15:00:00.000Z');                         // 同一天更早
  add('c', '2026-03-03T04:30:00.000Z');                         // 费城 3 月 2 日 23:30
  add('d', '2026-03-05T15:00:00.000Z', { deleted_at: '2026-03-06T00:00:00.000Z' });
  add('e', 'garbage');                                          // 无法识别：跳过
  t.repo.insert('checkins', { date_ny: '2026-03-05', first_entry_at: '2026-03-05T22:22:00.000Z' });   // 已有：不改
  assert.equal(t.g.svcBackfillCheckins(t.repo), 2);
  assert.deepEqual(rows(t), [
    { date_ny: '2026-03-05', first_entry_at: '2026-03-05T22:22:00.000Z' },
    { date_ny: '2026-03-01', first_entry_at: '2026-03-01T15:00:00.000Z' },
    { date_ny: '2026-03-02', first_entry_at: '2026-03-03T04:30:00.000Z' }
  ]);
  const once = JSON.stringify(rows(t));
  assert.equal(t.g.svcBackfillCheckins(t.repo), 0);
  assert.equal(JSON.stringify(rows(t)), once, '重复运行不变');
});

test('连续打卡：截止今天；今天没打卡时截止昨天；断开后从头算；没有打卡为 0', () => {
  const g = loadGas();
  const s = (dates, today) => g.checkinSummary(dates, today);
  assert.equal(s(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14').streak, 3);
  assert.equal(s(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14').checked_today, true);
  const y = s(['2026-10-11', '2026-10-12', '2026-10-13'], '2026-10-14');
  assert.equal(y.streak, 3, '今天还没记，截止昨天');
  assert.equal(y.checked_today, false);
  assert.equal(s(['2026-10-11', '2026-10-12'], '2026-10-14').streak, 0, '昨天也没记：断了');
  const broken = s(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06'], '2026-10-06');
  assert.equal(broken.streak, 2);
  assert.equal(broken.cumulative, 5);
  assert.equal(s([], '2026-10-06').streak, 0);
  assert.equal(s(['2026-02-28', '2026-03-01'], '2026-03-01').streak, 2, '跨月');
  assert.equal(s(['2026-10-14', '2026-10-14', '2026-10-13'], '2026-10-14').cumulative, 2, '重复日期只算一次');
});

test('本周一行：周一到周日，标出已打卡 / 今天 / 以后的日子；跨年也正确', () => {
  const g = loadGas();
  const w = plain(g.checkinSummary(['2026-10-12', '2026-10-14', '2026-10-09'], '2026-10-14').week);   // 2026-10-14 是周三
  assert.deepEqual(w.map((d) => d.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.deepEqual(w.map((d) => d.label), ['一', '二', '三', '四', '五', '六', '日']);
  assert.deepEqual(w.map((d) => d.checked), [true, false, true, false, false, false, false]);
  assert.deepEqual(w.map((d) => d.is_today), [false, false, true, false, false, false, false]);
  assert.deepEqual(w.map((d) => d.future), [false, false, false, true, true, true, true]);
  const ny = plain(g.checkinSummary([], '2027-01-01').week);          // 周五
  assert.equal(ny[0].date, '2026-12-28');
  assert.equal(ny[6].date, '2027-01-03');
  const sun = plain(g.checkinSummary([], '2026-10-18').week);         // 周日：仍属于 12 日开始的这一周
  assert.equal(sun[0].date, '2026-10-12');
  assert.equal(sun[6].is_today, true);
});

test('里程碑：1、3、7、14、30、50、100、200、365，之后 400、500、600……；下一个里程碑和还差几天', () => {
  const g = loadGas();
  const all = [];
  for (let n = 1; n <= 820; n++) if (g.isCheckinMilestone(n)) all.push(n);
  assert.deepEqual(all, [1, 3, 7, 14, 30, 50, 100, 200, 365, 400, 500, 600, 700, 800]);
  assert.equal(g.nextCheckinMilestone(0), 1);
  assert.equal(g.nextCheckinMilestone(46), 50);
  assert.equal(g.nextCheckinMilestone(365), 400);
  assert.equal(g.nextCheckinMilestone(399), 400);
  assert.equal(g.nextCheckinMilestone(400), 500);
  assert.equal(g.highestMilestoneReached(0), null);
  assert.equal(g.highestMilestoneReached(2), 1);
  assert.equal(g.highestMilestoneReached(46), 30);
  assert.equal(g.highestMilestoneReached(399), 365);
  assert.equal(g.highestMilestoneReached(523), 500);
  const s = g.checkinSummary(Array.from({ length: 46 }, (_, i) => g.addDaysNY('2026-10-14', -i)), '2026-10-14');
  assert.equal(s.cumulative, 46);
  assert.equal(s.streak, 46);
  assert.equal(s.next_milestone, 50);
  assert.equal(s.days_to_next, 4);
});
