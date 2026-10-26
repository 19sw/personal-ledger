'use strict';
/** 测试数据小工具：用和网页相同的入口（svcSaveEntry）录入账目。数字均为测试示例。 */
const { loadGas, memoryRepo, idGen } = require('./gas');

function setup(nowIso = '2026-02-20T15:00:00Z') {
  const g = loadGas();
  const repo = memoryRepo(g);
  const newId = idGen('e');
  g.svcEnsureDefaults(repo);
  let now = new Date(nowIso);
  const api = {
    g, repo, newId,
    setNow(iso) { now = new Date(iso); },
    now: () => now,
    cat(name, type = 'expense') {
      const c = repo.list('categories').find((x) => x.name === name && x.type === type);
      if (!c) throw new Error('no category ' + name);
      return c.id;
    },
    save(input) { return g.svcSaveEntry(repo, input, now, newId); },
    expense(amount, catName, local, extra = {}) {
      return api.save(Object.assign({ type: 'expense', amount, category_id: api.cat(catName), local_datetime: local }, extra));
    },
    income(amount, catName, local, extra = {}) {
      return api.save(Object.assign({ type: 'income', amount, category_id: api.cat(catName, 'income'), local_datetime: local }, extra));
    },
    /** 模拟一笔“自动记录、金额未知”的支出（手动记录金额必填，所以直接写入 repo） */
    autoPending(catName, local, channel = 'apple_pay') {
      const d = g.parseLocalNY(local);
      const e = {
        id: newId(), type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
        date_ny: g.dateNY(d), category_id: api.cat(catName), income_source_id: null, merchant: 'Apple Pay',
        note: '', channel, platform: null, is_refund: false, refund_of: null, flag_dup: false, dup_group: null,
        flag_amount_review: false, source_key: 'applepay:evt:test-' + Math.random(), order_ref: null,
        created_at: now.toISOString(), updated_at: now.toISOString(), deleted_at: null
      };
      repo.insert('entries', e);
      return e;
    },
    report(month) { return g.svcGetReport(repo, month, now); }
  };
  return api;
}

module.exports = { setup };
