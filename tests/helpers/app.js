'use strict';
/**
 * 网页测试工具：在 jsdom（模拟浏览器）里打开真实的 ui/index.html，像用户一样点击，
 * 后端是 tests/helpers/harness.js 中运行的真实服务器代码（Google 服务为模拟）。
 * 供 tests/ui.test.js 与 tests/ui-budget.test.js 共用。
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('node:fs');
const { createBackend } = require('./harness');

// 收集英文模式下漏翻的文字：I18N_COLLECT=文件路径 时，所有网页测试都以 English 打开，结束时把 window.__i18nMissing 写入该文件
const COLLECT = process.env.I18N_COLLECT || '';
const collected = [];
if (COLLECT) process.on('exit', () => {
  const all = {};
  collected.forEach((w) => Object.keys(w.__i18nMissing || {}).forEach((k) => { all[k] = (all[k] || 0) + w.__i18nMissing[k]; }));
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(COLLECT, 'utf8')); } catch (e) { /* 第一次 */ }
  Object.keys(all).forEach((k) => { prev[k] = (prev[k] || 0) + all[k]; });
  fs.writeFileSync(COLLECT, JSON.stringify(prev, null, 1));
});

/** 影子检查：中文界面照常运行，同时把页面上出现过的每段文字（含 aria-label 等）都试着翻译一遍，翻不了的记入 __i18nMissing。 */
function shadowCheck(w) {
  collected.push(w);
  const doc = w.document;
  const check = (node) => {
    const el = node.nodeType === 1 ? node : node.parentNode;
    if (!el || !el.closest || el.closest('script, style, [translate="no"]')) return;
    if (node.nodeType === 3) w.I18N.translate(node.nodeValue);
    else ['aria-label', 'placeholder', 'title'].forEach((a) => { const v = node.getAttribute(a); if (v) w.I18N.translate(v); });
  };
  const walk = (root) => {
    check(root);
    const tw = doc.createTreeWalker(root, 5);
    let n;
    while ((n = tw.nextNode())) check(n);
  };
  const realConfirm = w.confirm;
  w.confirm = (m) => { w.I18N.translate(String(m)); return realConfirm(m); };
  new w.MutationObserver((list) => list.forEach((m) => {
    if (m.type === 'characterData' || m.type === 'attributes') check(m.target);
    else m.addedNodes.forEach(walk);
  })).observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder', 'title'] });
  walk(doc.body);
}

async function openApp({ reducedMotion = true, backend: backendOpts, beforeOpen, lang } = {}) {
  const backend = createBackend(backendOpts);
  if (beforeOpen) beforeOpen(backend);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (e) => errors.push(String(e)));
  const dom = new JSDOM(backend.html(), {
    // 有 lang 时用 http 地址，才能使用 localStorage（界面语言记在这里）
    url: lang ? 'http://localhost/' : undefined,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      if (lang) window.localStorage.setItem('ledger.lang', lang);
      window.google = { script: { run: backend.scriptRun(window) } };
      window.confirm = () => true;
      window.scrollTo = () => {};
      // jsdom 没有 matchMedia：默认模拟“减少动态效果”（动画等待更短）；动画测试传 reducedMotion:false
      window.matchMedia = (q) => ({ matches: reducedMotion && /reduced-motion/.test(q), media: q, addListener() {}, removeListener() {} });
    }
  });
  const w = dom.window;
  if (COLLECT) shadowCheck(w);
  const doc = w.document;
  const app = {
    backend, w, doc, errors,
    $: (sel) => doc.querySelector(sel),
    $$: (sel) => Array.from(doc.querySelectorAll(sel)),
    text: (sel) => (doc.querySelector(sel) || {}).textContent || '',
    async until(fn, what) {
      for (let i = 0; i < 600; i++) {
        const v = fn();
        if (v) return v;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('等待超时：' + what + '\n页面：' + doc.body.textContent.slice(0, 500) + '\n错误：' + errors.join('; '));
    },
    click(el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); },
    set(sel, value, evt = 'change') {
      const el = doc.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new w.Event(evt, { bubbles: true }));
    },
    type(sel, value) { app.set(sel, value, 'input'); },
    nav(name) {
      // 清空目标页旧内容，避免等待条件被上一次的隐藏页面误满足
      const page = doc.getElementById('page-' + name);
      if (page) page.innerHTML = '';
      app.click(doc.querySelector(`[data-nav="${name}"]`));
    },
    /** 打开记一笔：类别网格 */
    async openGrid() {
      app.nav('form');
      await app.until(() => !app.$('#page-form').hidden && app.$$('#catgrid .tile').length, '类别网格');
    },
    tile: (name) => app.$$('#catgrid .tile').find((t) => t.querySelector('.nm').textContent === name),
    /** 点类别，等金额面板滑出 */
    async pick(name) {
      const t = app.tile(name);
      if (!t) throw new Error('网格里没有类别 ' + name);
      app.click(t);
      await app.until(() => app.$('#entry-sheet.open'), '金额面板');
    },
    /** 用自定义数字键盘输入金额，例如 keys('12.5')；'00' 用 key('00') */
    key(k) { app.click(app.$(`[data-act="key"][data-key="${k}"]`)); },
    keys(str) { for (const ch of String(str)) app.key(ch); },
    chip(name) { app.click(app.$$('#chips .chip').find((c) => c.dataset.chip === name)); },
    chipNames: () => app.$$('#chips .chip').map((c) => c.dataset.chip),
    /** 点“完成”，等到账目页用新数据重新渲染完成 */
    async saveAndWait() {
      doc.getElementById('page-entries').innerHTML = '';
      app.click(app.$('[data-act="save"]'));
      await app.until(() => !app.$('#page-entries').hidden && app.$('#page-entries .monthnav'), '保存完成');
    },
    /** 点列表里的账目，等编辑面板滑出 */
    async openEdit(id) {
      app.$('#page-form').innerHTML = '';
      app.click(app.$(`#page-entries [data-id="${id}"]`));
      await app.until(() => app.$('#entry-sheet.open'), '编辑面板');
    },
    currentMonth: () => w.__app.state.boot.current_month,
    /** 打开“我的”（主页面：黑猫头部 + 打卡 + 菜单） */
    async openMe() {
      app.nav('settings');
      await app.until(() => !app.$('#page-settings').hidden && app.$('#me-menu'), '我的');
    },
    /** 我的 → 菜单里的子页面：cats 类别管理 / sources 收入来源 / near 预算提醒比例 / deleted 最近删除 */
    async openMeSub(sub) {
      await app.openMe();
      app.$('#page-settings').querySelector('[data-sub="' + sub + '"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await app.until(() => app.$('#page-settings .subhead'), '子页面 ' + sub);
    },
    async addEntry({ type = 'expense', amount, category, day = '05', source, refund, merchant, note }) {
      await app.openGrid();
      if (type === 'income') {
        app.click(app.$('[data-act="tab"][data-type="income"]'));
        await app.until(() => app.$('#catgrid .tile.add') && app.tile('兼职'), '收入网格');
      }
      await app.pick(category || '其他');
      app.keys(amount);
      if (refund) {
        app.chip('refund');
        await app.until(() => app.$('#f-refund-of'), '退款选择');
        const opt = app.$$('#f-refund-of option').find((o) => o.textContent.includes(refund));
        app.set('#f-refund-of', opt.value);
      }
      if (source) {
        app.chip('source');
        await app.until(() => app.$('#f-source'), '来源选择');
        app.set('#f-source', '__new__');
        await app.until(() => app.$('#f-new-source'), '新来源');
        app.type('#f-new-source', source);
      }
      if (merchant) { app.chip('merchant'); app.type('#f-merchant', merchant); }
      if (note) app.type('#f-note', note);
      app.chip('date');
      await app.until(() => app.$('#f-datetime'), '日期');
      app.set('#f-datetime', app.currentMonth() + '-' + day + 'T12:00');
      await app.saveAndWait();
    }
  };
  await app.until(() => app.$('#page-entries .monthnav'), '首页加载');
  return app;
}

module.exports = { openApp };
