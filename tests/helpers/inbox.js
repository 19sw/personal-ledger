'use strict';
/**
 * 测试辅助：把项目 I（apps/inbox，Apple Pay 收件口）的代码放进模拟的 Apps Script 环境运行。
 * 「收件箱」表格用 fake-sheets.js 的假表格；时钟、脚本锁、脚本属性都可以由测试控制。
 * 测试调用的是真正的 doPost（与线上相同的入口），所以 core.js 和 inbox.js 的连接代码都会被测到。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeSpreadsheet } = require('./fake-sheets');

const INBOX_DIR = path.join(__dirname, '..', '..', 'apps', 'inbox');
/** 测试用口令（不是任何真实口令）：32 个字符 */
const TEST_TOKEN = 'test-token-0123456789-abcdefghij';

function loadInbox({ token = TEST_TOKEN, now = '2026-10-15T15:00:00.000Z', ss = new FakeSpreadsheet(), setup = true } = {}) {
  let clock = new Date(now).getTime();
  const logs = [];
  const log = (...a) => logs.push(a.map(String).join(' '));
  const props = { INGEST_TOKEN: token };
  const lock = { allow: true, held: false, attempts: 0, releases: 0 };
  const RealDate = Date;
  // 可控时钟：new Date() 与 Date.now() 返回测试设定的时间，其他用法与真实 Date 相同
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
    static now() { return clock; }
  }
  const appended = [];   // 每次 appendRow 写入的原始值（检查单引号前缀）
  const ctx = vm.createContext({
    console: { log, warn: log, error: log, info: log },
    Date: FakeDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = String(v); }
    }) },
    Utilities: { getUuid: () => require('node:crypto').randomUUID() },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { lock.attempts++; if (!lock.allow) return false; lock.held = true; return true; },
        releaseLock: () => { lock.held = false; lock.releases++; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } })
    }
  });
  for (const f of ['core.js', 'inbox.js']) {
    vm.runInContext(fs.readFileSync(path.join(INBOX_DIR, f), 'utf8'), ctx, { filename: 'inbox/' + f });
  }
  if (setup) ctx.setupInbox();
  const sheet = () => ss.getSheetByName('inbox');
  if (setup) {
    const orig = sheet().appendRow.bind(sheet());
    sheet().appendRow = (values) => { appended.push(values.slice()); orig(values); };
  }

  const api = {
    ctx, ss, logs, props, lock, appended, sheet,
    setNow(iso) { clock = new RealDate(iso).getTime(); },
    advance(ms) { clock += ms; },
    nowIso() { return new RealDate(clock).toISOString(); },
    /** 发送一次 POST；body 为对象时自动 JSON 化并带上口令（除非对象里自己写了 token） */
    post(body, { raw = false } = {}) {
      const contents = raw ? body : JSON.stringify(Object.assign({ token }, body));
      const out = ctx.doPost({ postData: { contents, length: contents.length, type: 'application/json' } });
      return { res: JSON.parse(out.getContent()), mime: out.mime };
    },
    pay(eventId, extra = {}) {
      return api.post(Object.assign({ event_id: eventId, amount_text: '$12.34', merchant_text: "TRADER JOE'S",
        occurred_at_text: '2026-10-15T11:00:00-04:00', shortcut_version: '1' }, extra)).res;
    },
    /** 数据行（不含表头），按列名还原成对象 */
    rows() {
      const cols = ctx.INBOX_COLUMNS;
      return sheet().rows.slice(1).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] === undefined ? '' : r[i]])));
    },
    txnRows() { return api.rows().filter((r) => r.row_type === 'txn'); },
    markerRows() { return api.rows().filter((r) => r.row_type === 'rate_limited'); },
    /** 直接往表里放一行（模拟以前写入的行），received_at 为 ISO 文字 */
    seed(rowType, receivedIso, eventId = '', count = '') {
      sheet().rows.push([rowType, receivedIso, eventId, '', '', '', '', count]);
    }
  };
  return api;
}

module.exports = { loadInbox, TEST_TOKEN, INBOX_DIR };
