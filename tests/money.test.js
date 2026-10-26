'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');

const g = loadGas();

test('parseUsdToCents：常见写法转为整数美分', () => {
  assert.equal(g.parseUsdToCents('12.34'), 1234);
  assert.equal(g.parseUsdToCents('$12.34'), 1234);
  assert.equal(g.parseUsdToCents('US$1,234.5'), 123450);
  assert.equal(g.parseUsdToCents('1,234.56 USD'), 123456);
  assert.equal(g.parseUsdToCents(' 120 '), 12000);
  assert.equal(g.parseUsdToCents('0.1'), 10);
  assert.equal(g.parseUsdToCents('１２．３４'), 1234, '全角数字（NFKC）');
  // 0.1 + 0.2 之类的浮点误差不会出现：全程整数
  assert.equal(g.parseUsdToCents('0.29'), 29);
  assert.equal(g.parseUsdToCents('19.99'), 1999);
});

test('parseUsdToCents：无法识别时返回 null', () => {
  for (const bad of ['', '   ', 'abc', '12.345', '1,2', '¥12', '€5', '-5', '12..3', null, undefined, '1234567890']) {
    assert.equal(g.parseUsdToCents(bad), null, String(bad));
  }
});

test('formatCents 与百分比', () => {
  assert.equal(g.formatCents(123456), '1,234.56');
  assert.equal(g.formatCents(-2000), '-20.00');
  assert.equal(g.formatCents(5), '0.05');
  assert.equal(g.formatCents(null), '—');
  assert.equal(g.percentTenths(12000, 20000), 600);
  assert.equal(g.formatPercentTenths(600), '60.0%');
  // 四舍五入（0.5 进位）：1/3 = 33.3%，2/3 = 66.7%，1/8 = 12.5%，1/16 = 6.25% → 6.3%
  assert.equal(g.percentTenths(1, 3), 333);
  assert.equal(g.percentTenths(2, 3), 667);
  assert.equal(g.percentTenths(1, 8), 125);
  assert.equal(g.percentTenths(1, 16), 63);
  assert.equal(g.percentTenths(5, 0), null);
  assert.equal(g.percentTenths(-5, 100), null);
});
