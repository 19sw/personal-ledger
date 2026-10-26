'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');

const g = loadGas();

test('PRD 月份归属：费城 1 月 31 日 23:30 = UTC 2 月 1 日 04:30 → 2026-01', () => {
  const d = g.parseLocalNY('2026-01-31T23:30');
  assert.equal(d.toISOString(), '2026-02-01T04:30:00.000Z');
  assert.equal(g.monthNY(d), '2026-01');
  assert.equal(g.dateNY(d), '2026-01-31');
  // 同一时刻按 UTC 看已是 2 月，但账本按费城时间归入 1 月
  assert.equal(g.monthNY(new Date('2026-02-01T04:30:00Z')), '2026-01');
  assert.equal(g.monthNY(new Date('2026-02-01T05:00:00Z')), '2026-02');
});

test('夏令时：7 月为 UTC-4，1 月为 UTC-5', () => {
  assert.equal(g.parseLocalNY('2026-07-31T23:30').toISOString(), '2026-08-01T03:30:00.000Z');
  assert.equal(g.monthNY(new Date('2026-08-01T03:30:00Z')), '2026-07');
  assert.equal(g.monthNY(new Date('2026-08-01T04:00:00Z')), '2026-08');
});

test('夏令时开始（2026-03-08 02:30 不存在）→ 按 03:30 夏令时处理', () => {
  const d = g.parseLocalNY('2026-03-08T02:30');
  assert.equal(d.toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(g.localNY(d), '2026-03-08T03:30');
});

test('夏令时结束（2026-11-01 01:30 出现两次）→ 取较早的时刻（夏令时）', () => {
  const d = g.parseLocalNY('2026-11-01T01:30');
  assert.equal(d.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(g.localNY(new Date('2026-11-01T06:30:00Z')), '2026-11-01T01:30');
});

test('localNY / parseLocalNY 来回转换一致；手机时区不影响', () => {
  for (const local of ['2026-01-01T00:00', '2026-06-15T12:05', '2026-12-31T23:59', '2028-02-29T10:00']) {
    assert.equal(g.localNY(g.parseLocalNY(local)), local);
  }
});

test('手机（运行环境）在别的时区时，结果不变', () => {
  const saved = process.env.TZ;
  try {
    for (const tz of ['Asia/Shanghai', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(g.parseLocalNY('2026-01-31T23:30').toISOString(), '2026-02-01T04:30:00.000Z', tz);
      assert.equal(g.monthNY(new Date('2026-02-01T04:30:00Z')), '2026-01', tz);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

test('parseLocalNY 拒绝错误格式与不存在的日期', () => {
  for (const bad of ['2026-02-30T10:00', '2026-13-01T00:00', '2026-01-01 10:00', '', null, '2026-01-01T24:00']) {
    assert.throws(() => g.parseLocalNY(bad), String(bad));
  }
});

test('addMonths 跨年', () => {
  assert.equal(g.addMonths('2026-01', -1), '2025-12');
  assert.equal(g.addMonths('2025-12', 1), '2026-01');
  assert.equal(g.addMonths('2026-03', -14), '2025-01');
});

test('Intl 不可用时改用 Utilities.formatDate（Apps Script 后备路径）', () => {
  const calls = [];
  const fakeUtilities = {
    formatDate(date, tz, pattern) {
      calls.push([tz, pattern]);
      // 用 Node 的 Intl 模拟 Apps Script 的 Utilities.formatDate
      const p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
      return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}`;
    }
  };
  const g2 = loadGas([], { Utilities: fakeUtilities, Intl: { DateTimeFormat: function () { throw new Error('no tz'); } } });
  assert.equal(g2.monthNY(new Date('2026-02-01T04:30:00Z')), '2026-01');
  assert.equal(g2.parseLocalNY('2026-11-01T01:30').toISOString(), '2026-11-01T05:30:00.000Z');
  assert.ok(calls.length > 0 && calls.every((c) => c[0] === 'America/New_York'));
});
