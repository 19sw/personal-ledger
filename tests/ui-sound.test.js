'use strict';
/** 网页测试（Task 09）：切页音效 S2、保存成功音效 R3 + 飘字、音效开关。通过替换 __app.sound.play 观察。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');

const tap = (app, name) => app.click(app.$(`.bottomnav [data-nav="${name}"]`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** jsdom 的 about:blank 页面没有 localStorage：装一个内存版 */
function fakeStorage(app) {
  const m = new Map();
  Object.defineProperty(app.w, 'localStorage', { configurable: true, value: { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) } });
}
function spy(app) { const calls = []; app.w.__app.sound.play = (n) => calls.push(n); return calls; }
const visible = (app) => app.$$('main > .page').filter((p) => !p.hidden).map((p) => p.id);

test('切页音：动画路径在真正切页时响一次；记一笔、当前标签不响', async () => {
  const app = await openApp({ reducedMotion: false });
  const calls = spy(app);
  tap(app, 'entries'); tap(app, 'form');
  await app.until(() => !app.$('#page-form').hidden, '记一笔页');
  assert.deepEqual(calls, [], '当前标签、记一笔：无声');
  tap(app, 'report');
  await app.until(() => visible(app).join() === 'page-report', '报表');
  assert.deepEqual(calls, ['s2']);
  await wait(400);
  assert.deepEqual(calls, ['s2'], '涟漪结束后不重复');
  assert.deepEqual(app.errors, []);
});

test('切页音：减少动态效果时同样响一次', async () => {
  const app = await openApp({ reducedMotion: true });
  const calls = spy(app);
  tap(app, 'budget');
  assert.deepEqual(calls, ['s2']);
  tap(app, 'budget');
  assert.deepEqual(calls, ['s2'], '当前标签不响');
});

test('保存成功：响 R3 并飘出带符号金额，约 1.1 秒后移除；失败不响', async () => {
  const app = await openApp({ reducedMotion: false });
  const calls = spy(app);
  await app.openGrid();
  await app.pick('其他');
  app.keys('32');
  app.click(app.$('[data-act="save"]'));
  await app.until(() => app.$('.save-float'), '飘字');
  assert.deepEqual(calls.filter((c) => c === 'r3'), ['r3']);
  assert.equal(app.$('.save-float').textContent, '−32.00 已记好');
  await app.until(() => !app.$('.save-float'), '飘字移除');

  // 收入
  await app.openGrid();
  app.click(app.$('[data-act="tab"][data-type="income"]'));
  await app.until(() => app.$('#catgrid .tile.add') && app.tile('兼职'), '收入网格');
  await app.pick('兼职');
  app.keys('5.5');
  app.click(app.$('[data-act="save"]'));
  await app.until(() => app.$('.save-float'), '收入飘字');
  assert.equal(app.$('.save-float').textContent, '+5.50 已记好');
  await app.until(() => !app.$('.save-float'), '飘字移除');
  assert.deepEqual(app.errors, []);
});

test('保存失败不响也不飘字', async () => {
  const app = await openApp({ reducedMotion: true });
  const calls = spy(app);
  await app.openGrid();
  await app.pick('其他');
  app.keys('3');
  // 让保存请求失败：替换 google.script.run 为总是失败的实现
  const fail = { withSuccessHandler() { return { withFailureHandler(f) { return new Proxy({}, { get: () => () => f(new Error('boom')) }); } }; } };
  app.w.google.script.run = fail;
  app.click(app.$('[data-act="save"]'));
  await wait(100);
  assert.deepEqual(calls, []);
  assert.equal(app.$('.save-float'), null);
});

test('减少动态效果：保存成功有声但不飘字', async () => {
  const app = await openApp({ reducedMotion: true });
  const calls = spy(app);
  await app.addEntry({ amount: '8', category: '其他' });
  assert.deepEqual(calls, ['r3']);
  assert.equal(app.$('.save-float'), null);
});

test('音效开关：我的里默认开，点击关闭并记住；关闭后切页与保存都无声', async () => {
  const app = await openApp({ reducedMotion: true });
  const calls = spy(app);
  fakeStorage(app);
  await app.openMe();
  const sw = app.$('#sound-switch');
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(app.w.localStorage.getItem('ledger.sound'), null);
  app.click(sw);
  assert.equal(app.w.localStorage.getItem('ledger.sound'), 'off');
  assert.equal(app.$('#sound-switch').getAttribute('aria-checked'), 'false');
  calls.length = 0;
  tap(app, 'budget'); tap(app, 'settings');
  await app.addEntry({ amount: '2', category: '其他' });
  assert.deepEqual(calls, [], '关闭后无声');
  await app.openMe();
  assert.equal(app.$('#sound-switch').getAttribute('aria-checked'), 'false', '重新渲染后仍是关');
  app.click(app.$('#sound-switch'));
  assert.equal(app.w.localStorage.getItem('ledger.sound'), 'on');
  tap(app, 'budget');
  assert.deepEqual(calls, ['s2']);
});

test('没有 Web Audio / localStorage 不可用：不抛错，视为开', async () => {
  const app = await openApp({ reducedMotion: true });
  tap(app, 'budget'); tap(app, 'report');   // 真实 synth，jsdom 无 AudioContext
  app.w.__app.sound.synth('s2'); app.w.__app.sound.synth('r3');
  Object.defineProperty(app.w, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  const calls = spy(app);
  tap(app, 'entries');
  assert.deepEqual(calls, ['s2']);
  assert.deepEqual(app.errors, []);
});

test('合成参数：S2 滑音与 R3 三音按规格调度', async () => {
  const app = await openApp({ reducedMotion: true });
  const log = [];
  class FakeCtx {
    constructor() { this.currentTime = 1; this.state = 'running'; this.destination = {}; }
    createOscillator() { const o = { type: '', frequency: { setValueAtTime: (v, t) => log.push(['f0', v, t]), exponentialRampToValueAtTime: (v, t) => log.push(['f1', v, t]) }, connect() {}, start: (t) => log.push(['start', t]), stop() {} }; return o; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime: (v, t) => log.push(['peak', v, t]), exponentialRampToValueAtTime: (v) => log.push(['end', v]) }, connect() {} }; }
  }
  app.w.AudioContext = FakeCtx;
  app.w.__app.sound.synth('s2');
  assert.deepEqual(log.filter((l) => l[0] === 'f0' || l[0] === 'f1').map((l) => [l[0], l[1]]), [['f0', 1400], ['f1', 700]]);
  assert.equal(log.find((l) => l[0] === 'peak')[1], 0.10);
  log.length = 0;
  app.w.__app.sound.synth('r3');
  assert.deepEqual(log.filter((l) => l[0] === 'f0').map((l) => l[1]), [660, 880, 1175]);
  assert.deepEqual(log.filter((l) => l[0] === 'peak').map((l) => l[1]), [0.11, 0.11, 0.12]);
  assert.deepEqual(app.errors, []);
});

test('iOS 解锁：第一次手势就建好 AudioContext 并 resume（早于任何播放），running 后移除监听', async () => {
  const app = await openApp({ reducedMotion: true });
  const log = [];
  let ctx;
  class FakeCtx {
    constructor() { ctx = this; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; log.push('construct'); }
    resume() { log.push('resume'); this.state = 'running'; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() { log.push('silent-start'); } }; }
  }
  app.w.AudioContext = FakeCtx;
  const calls = []; app.w.__app.sound.play = (n) => calls.push(n);
  app.$('body').dispatchEvent(new app.w.Event('pointerdown', { bubbles: true }));
  assert.deepEqual(log, ['construct', 'resume', 'silent-start']);
  assert.deepEqual(calls, []);
  log.length = 0;
  app.$('body').dispatchEvent(new app.w.Event('pointerdown', { bubbles: true }));
  app.click(app.$('body'));
  assert.deepEqual(log, [], 'running 之后监听已移除');
  assert.equal(ctx.state, 'running');
  assert.deepEqual(app.errors, []);
});

test('synth：interrupted 状态也会 resume', async () => {
  const app = await openApp({ reducedMotion: true });
  let resumed = 0;
  class FakeCtx {
    constructor() { this.state = 'interrupted'; this.currentTime = 0; this.destination = {}; }
    resume() { resumed++; }
    createOscillator() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  app.w.AudioContext = FakeCtx;
  app.w.__app.sound.synth('s2');
  assert.equal(resumed, 1);
});

test('退款保存：飘字用“+”', async () => {
  const app = await openApp({ reducedMotion: false });
  await app.addEntry({ amount: '120', category: '其他', day: '03' });
  await app.until(() => !app.$('.save-float'), '上一条飘字移除');
  await app.openGrid();
  await app.pick('其他');
  app.keys('20');
  app.chip('refund');
  await app.until(() => app.$('#f-refund-of'), '退款选择');
  const opt = app.$$('#f-refund-of option').find((o) => o.textContent.includes('$120.00'));
  app.set('#f-refund-of', opt.value);
  app.click(app.$('[data-act="save"]'));
  await app.until(() => app.$('.save-float'), '飘字');
  assert.equal(app.$('.save-float').textContent, '+20.00 已记好');
});
