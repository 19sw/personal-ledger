'use strict';
/**
 * 本地“整条路径”测试台：把 apps/main 的全部服务器代码（web.js、store.js、jobs.js、core/*）
 * 放进模拟的 Apps Script 环境里运行，Google 服务用假的实现代替：
 *   SpreadsheetApp → 假表格（fake-sheets.js）   LockService / PropertiesService / Utilities / HtmlService → 简单模拟
 * 网页端通过假的 google.script.run 调用 api_* 函数，与正式环境的调用方式一致。
 * 用途：UI 冒烟测试（tests/ui.test.js）和本地预览（tools/preview.js）。不连接任何 Google 服务。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadGas, MAIN } = require('./gas');
const { FakeSpreadsheet } = require('./fake-sheets');

function htmlServiceFake() {
  const readHtml = (name) => fs.readFileSync(path.join(MAIN, name + '.html'), 'utf8');
  function output(content) {
    return {
      getContent: () => content,
      setTitle() { return this; },
      addMetaTag() { return this; },
      setXFrameOptionsMode() { return this; }
    };
  }
  const svc = {
    createHtmlOutputFromFile: (name) => output(readHtml(name)),
    createTemplateFromFile: (name) => ({
      // 只支持本项目用到的 <?!= include('…') ?> 写法
      evaluate: () => output(readHtml(name).replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, (_, f) => svc.include(f)))
    }),
    include: null
  };
  return svc;
}

/** 假的 ScriptApp：记录安装了哪些定时器（installTriggers 的测试用）。 */
function scriptAppFake() {
  const triggers = [];
  const builder = (handler) => {
    const spec = { handler };
    const b = {
      timeBased() { return b; },
      everyDays(n) { spec.everyDays = n; return b; },
      everyMinutes(n) { spec.everyMinutes = n; return b; },
      atHour(h) { spec.atHour = h; return b; },
      inTimezone(tz) { spec.tz = tz; return b; },
      create() { const t = { spec, getHandlerFunction: () => handler }; triggers.push(t); return t; }
    };
    return b;
  };
  return {
    triggers,
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: builder
  };
}

/**
 * opts.props：脚本属性（例如 {INBOX_SPREADSHEET_ID: 'test-inbox'}）；
 * opts.spreadsheets：openById 可以打开的假表格 {id: FakeSpreadsheet}（「收件箱」用）。
 * 默认两者都为空：与线上“还没设置收件箱”的状态相同。
 */
function utilitiesFake() {
  return {
    getUuid: () => crypto.randomUUID(),
    // 与 Apps Script 相同：base64DecodeWebSafe 返回字节数组，newBlob(bytes).getDataAsString() 按 UTF-8 还原
    base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s), 'base64url')),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
  };
}

/**
 * opts.gmail：假的高级 Gmail 服务（tests/helpers/gmail.js 的 fakeGmail().service）；不传 = 没有启用高级服务。
 * opts.console：替换 console（检查日志内容用）。
 */
function createBackend(opts = {}) {
  const ss = new FakeSpreadsheet();
  const html = htmlServiceFake();
  const props = Object.assign({}, opts.props || {});
  const books = opts.spreadsheets || {};
  const createdSpreadsheets = [];
  const scriptApp = scriptAppFake();
  // 脚本锁：lock.allow = false 模拟“拿不到锁”；lock.attempts 记录尝试次数；ledgerOpens 记录打开账本的次数
  const lock = { allow: true, attempts: 0 };
  let ledgerOpens = 0;
  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => { ledgerOpens++; return ss; },
      openById: (id) => { if (!books[id]) throw new Error('openById 打不开 ' + id); return books[id]; },
      create: (name) => {
        const output = new FakeSpreadsheet('generated-' + (createdSpreadsheets.length + 1));
        output.name = name;
        output.insertSheet('Sheet1');
        createdSpreadsheets.push(output);
        return output;
      },
      flush: () => {}
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { lock.attempts++; return lock.allow; }, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: utilitiesFake(),
    ScriptApp: scriptApp,
    HtmlService: html
  };
  if (opts.gmail) globals.Gmail = opts.gmail;
  if (opts.console) globals.console = opts.console;
  // opts.now：固定服务器时钟（ISO 文字），new Date() 与 Date.now() 返回这一刻；不传 = 真实时间
  if (opts.now) {
    const clock = new Date(opts.now).getTime();
    const RealDate = Date;
    globals.Date = class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(clock); else super(...a); }
      static now() { return clock; }
    };
  }
  const g = loadGas(['store.js', 'web.js', 'jobs.js', 'gmail.js'], globals);
  html.include = (name) => g.include(name);
  g.setupLedger();

  /** 模拟 google.script.run：只允许调用不以 _ 结尾的全局函数；参数和结果都经过 JSON 复制。 */
  function scriptRun(window) {
    function runner(success, failure) {
      return new Proxy({}, {
        get(_, prop) {
          if (prop === 'withSuccessHandler') return (fn) => runner(fn, failure);
          if (prop === 'withFailureHandler') return (fn) => runner(success, fn);
          return (...args) => {
            window.setTimeout(() => {
              if (typeof g[prop] !== 'function' || String(prop).endsWith('_')) {
                if (failure) failure(new window.Error('Script function not found: ' + String(prop)));
                return;
              }
              let result;
              try {
                result = g[prop](...JSON.parse(JSON.stringify(args)));
              } catch (e) {
                if (failure) failure(new window.Error(e.message));
                return;
              }
              if (success) success(result === undefined ? undefined : JSON.parse(JSON.stringify(result)));
            }, 0);
          };
        }
      });
    }
    return runner(null, null);
  }

  return { g, ss, props, scriptApp, createdSpreadsheets, lock, ledgerOpens: () => ledgerOpens, html: () => g.doGet().getContent(), scriptRun };
}

module.exports = { createBackend };
