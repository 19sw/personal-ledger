'use strict';
/**
 * 测试辅助：模拟 Apps Script 的运行方式——把 apps/main 下的多个 .js 文件放进同一个全局作用域运行。
 * 这样测试的就是将来推送到 Google 的同一份代码（不需要 module.exports）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAIN = path.join(__dirname, '..', '..', 'apps', 'main');
const CORE_FILES = ['core/money.js', 'core/time.js', 'core/status.js', 'core/schema.js',
  'core/report.js', 'core/ledger.js', 'core/budget.js', 'core/checkin.js', 'core/assistant.js', 'core/service.js',
  'core/savings.js', 'core/savings_service.js',
  'core/inbox.js', 'core/applepay.js',
  'core/transaction_table.js', 'core/receipt_text.js', 'core/platforms/doordash.js', 'core/platforms/uber.js', 'core/platforms/ubereats.js',
  'core/receipt_registry.js', 'core/receipt_pipeline.js'];

/**
 * 载入代码，返回全局对象（文件顺序与 Apps Script 无关，全局函数在调用时才查找）。extraFiles 例如 ['store.js']；globals 用来注入假的 Google 服务。
 */
function loadGas(extraFiles = [], globals = {}) {
  const ctx = vm.createContext(Object.assign({ console }, globals));
  for (const f of CORE_FILES.concat(extraFiles)) {
    vm.runInContext(fs.readFileSync(path.join(MAIN, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

/** 内存版 repo：与 store.js 的表格版遵守同一接口（list/insert/update/removeByKeys）。 */
function memoryRepo(g, { without = [] } = {}) {
  const tables = {};
  for (const t of Object.keys(g.LEDGER_SCHEMA)) if (!without.includes(t)) tables[t] = [];
  const keyOf = (t) => g.LEDGER_SCHEMA[t].key;
  const need = (t) => { if (!tables[t]) throw new Error('缺少工作表 ' + t); return tables[t]; };
  return {
    tables,
    has: (t) => !!tables[t],
    list: (t) => need(t).map((r) => Object.assign({}, r)),
    insert: (t, obj) => { need(t).push(Object.assign({}, obj)); },
    update: (t, k, patch) => {
      const row = need(t).find((r) => r[keyOf(t)] === k);
      if (!row) throw new Error('not found ' + t + ':' + k);
      Object.assign(row, patch);
    },
    removeByKeys: (t, keys) => { tables[t] = tables[t].filter((r) => !keys.includes(r[keyOf(t)])); }
  };
}

function idGen(prefix = 'id') {
  let n = 0;
  return () => prefix + '-' + (++n);
}

/** 把 vm 中的对象转成普通对象，便于 assert.deepStrictEqual 比较。 */
function plain(x) { return JSON.parse(JSON.stringify(x)); }

module.exports = { loadGas, memoryRepo, idGen, plain, MAIN };
