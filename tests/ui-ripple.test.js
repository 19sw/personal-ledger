'use strict';
/** 网页测试（Task 08）：底部导航薄荷涟漪切页 + 高亮胶囊。动画测试用 reducedMotion:false（真实计时器）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');

const visible = (app) => app.$$('main > .page').filter((p) => !p.hidden).map((p) => p.id);
const ripples = (app) => app.$$('.ripple-clip');
const tap = (app, name) => app.click(app.$(`.bottomnav [data-nav="${name}"]`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('涟漪：点另一个标签，先出现涟漪，盖满后切页，结束后涟漪被移除', async () => {
  const app = await openApp({ reducedMotion: false });
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  assert.equal(ripples(app).length, 0, '首次加载没有涟漪');
  tap(app, 'report');
  assert.equal(ripples(app).length, 1, '点击后出现涟漪');
  assert.ok(app.$('.bottomnav [data-nav="report"]').classList.contains('active'), '高亮立刻跟过去');
  assert.equal(ripples(app)[0].style.pointerEvents || 'css', 'css');
  await app.until(() => visible(app).join() === 'page-report', '切到报表');
  await app.until(() => ripples(app).length === 0, '涟漪移除');
  assert.deepEqual(visible(app), ['page-report']);
  await wait(300);
  assert.equal(app.$('#page-report').classList.contains('page-enter'), false);
  assert.deepEqual(app.errors, []);
});

test('涟漪：连点几个标签，以最后一次为准，只显示一页，没有残留涟漪', async () => {
  const app = await openApp({ reducedMotion: false });
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  tap(app, 'report'); tap(app, 'budget'); await wait(80); tap(app, 'settings');
  assert.equal(ripples(app).length, 1, '前面的涟漪被清掉，只剩一个');
  await wait(900);
  assert.deepEqual(visible(app), ['page-settings']);
  assert.equal(ripples(app).length, 0);
  assert.equal(app.$$('.bottomnav .navitem.active').length, 1);
  assert.ok(app.$('.bottomnav [data-nav="settings"]').classList.contains('active'));
  assert.equal(app.$$('.page-enter').length <= 1, true);
  assert.deepEqual(app.errors, []);
});

test('涟漪：点当前标签、点记一笔都没有涟漪；回到当前页不会被延迟切页覆盖', async () => {
  const app = await openApp({ reducedMotion: false });
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  tap(app, 'entries');
  assert.equal(ripples(app).length, 0, '当前标签：无涟漪');
  tap(app, 'form');
  assert.equal(ripples(app).length, 0, '记一笔：无涟漪');
  await app.until(() => !app.$('#page-form').hidden, '记一笔页');
  // 先点报表（涟漪进行中）再立刻点记一笔：报表的延迟切页必须被取消
  tap(app, 'report'); tap(app, 'form');
  await wait(500);
  assert.deepEqual(visible(app), ['page-form']);
  assert.equal(ripples(app).length, 0);
});

test('减少动态效果：立即切页，不创建涟漪', async () => {
  const app = await openApp({ reducedMotion: true });
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  tap(app, 'budget');
  assert.equal(ripples(app).length, 0);
  assert.deepEqual(visible(app), ['page-budget'], '同步切换');
  assert.ok(app.$('.bottomnav [data-nav="budget"]').classList.contains('active'));
});

test('胶囊：存在，记一笔页隐藏，回到标签页重新出现', async () => {
  const app = await openApp({ reducedMotion: true });
  await app.until(() => app.$('#page-entries .monthnav'), '账目页');
  assert.ok(app.$('#navpill').classList.contains('on'));
  tap(app, 'form');
  await app.until(() => !app.$('#page-form').hidden, '记一笔页');
  assert.equal(app.$('#navpill').classList.contains('on'), false);
  tap(app, 'settings');
  assert.ok(app.$('#navpill').classList.contains('on'));
});
