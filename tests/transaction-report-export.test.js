'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./helpers/harness');
const { coerce } = require('./helpers/fake-sheets');

test('report export writes formula-like descriptions and category names as literal text', () => {
  const { g } = createBackend();
  const examples = [
    ['=1+1', '=SUM(A1:A2)'],
    ["'quoted merchant", "'quoted category"],
    ['Ordinary merchant', '餐饮']
  ];
  const report = { start_date: '2026-10-01', end_date: '2026-10-22', opening_balance_cents: 0,
    opening_pending_count: 0, months: [{ month: '2026-10', budget: null,
      rows: examples.map(([description, category]) => ({ date: '2026-10-16', description, category,
        income_cents: null, expense_cents: 100, balance_cents: -100, status: '' })) }] };
  const payload = g.transactionReportSheetValues_(report).slice(5);
  assert.equal(payload[0][1], "'=1+1", 'setValues must receive a literal text escape, not a formula');
  assert.equal(payload[0][2], "'=SUM(A1:A2)");
  assert.equal(payload[1][1], "''quoted merchant", 'preserve a real leading apostrophe');
  assert.equal(payload[2][1], 'Ordinary merchant');
  assert.equal(payload[2][2], '餐饮');
  payload.forEach((row, i) => {
    assert.equal(coerce(row[1]), examples[i][0], 'literal escape is not part of the displayed description');
    assert.equal(coerce(row[2]), examples[i][1]);
    assert.equal(row[4], 1, 'money remains numeric');
  });
});
