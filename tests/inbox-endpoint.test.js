'use strict';
/**
 * 项目 I（Apple Pay 收件口）的自动测试：spec 5.1 第 3 步、5.3，以及 §10 切片 3 的测试清单。
 * 全部通过真正的 doPost 入口调用。数字和口令都是测试示例。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadInbox, TEST_TOKEN, INBOX_DIR } = require('./helpers/inbox');
const { loadGas } = require('./helpers/gas');

const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();

// ---------------- 部署设置与公开面 ----------------

test('项目 I 的配置：任何人可访问、以部署者身份运行、只申请 spreadsheets.currentonly 一个权限', () => {
  const m = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, 'appsscript.json'), 'utf8'));
  assert.deepEqual(m.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets.currentonly']);
  assert.equal(m.webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(m.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(m.runtimeVersion, 'V8');
});

test('项目 I 的 .clasp.json（本机文件，含脚本 ID）不被 git 跟踪，并被 .gitignore 覆盖', (t) => {
  const skip = require('./helpers/git').assertNeverCommitted(assert, 'apps/inbox/.clasp.json');
  if (skip) t.skip(skip);
});

test('项目 I 只有 doPost 一个网页入口：没有 doGet；其余公开函数只在脚本编辑器里运行（setupInbox、createIngestToken）', () => {
  const t = loadInbox();
  assert.equal(typeof t.ctx.doGet, 'undefined');
  const names = [];
  for (const f of ['core.js', 'inbox.js']) {
    const src = fs.readFileSync(path.join(INBOX_DIR, f), 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)) if (!m[1].endsWith('_')) names.push(m[1]);
  }
  assert.deepEqual(names.sort(), ['createIngestToken', 'doPost', 'setupInbox']);
});

test('createIngestToken：生成 64 个字符的随机口令存进脚本属性，日志里不显示；已有口令时不覆盖', () => {
  const t = loadInbox({ token: null });
  t.ctx.createIngestToken();
  const tok = t.props.INGEST_TOKEN;
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.ok(!t.logs.some((l) => l.includes(tok)));
  t.ctx.createIngestToken();
  assert.equal(t.props.INGEST_TOKEN, tok, '不覆盖');
  assert.deepEqual(t.post({ token: tok, event_id: 'evt-1' }).res, { ok: true }, '生成的口令可以直接使用');
});

test('收件口与主程序的 inbox 列定义完全一致', () => {
  const t = loadInbox();
  const g = loadGas();
  assert.deepEqual(Array.from(t.ctx.INBOX_COLUMNS), Array.from(g.INBOX_COLUMNS));
});

test('setupInbox：建好表头，重复运行不改动已有数据；表头被改动时停止', () => {
  const t = loadInbox();
  assert.deepEqual(t.sheet().rows[0], Array.from(t.ctx.INBOX_COLUMNS));
  t.pay('evt-1');
  t.ctx.setupInbox();
  assert.equal(t.txnRows().length, 1);
  t.sheet().rows[0][2] = 'oops';
  assert.throws(() => t.ctx.setupInbox(), /第 3 列应为 event_id/);
});

// ---------------- 正常写入 ----------------

test('口令正确：追加一行交易，received_at 是服务器时间，返回只有 {ok:true}', () => {
  const t = loadInbox({ now: '2026-10-15T15:00:00.000Z' });
  const { res, mime } = t.post({ event_id: 'evt-1', amount_text: '$12.34', merchant_text: "TRADER JOE'S",
    occurred_at_text: '2026-10-15T11:00:00-04:00', shortcut_version: '1' });
  assert.deepEqual(res, { ok: true });
  assert.equal(mime, 'application/json');
  const rows = t.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { row_type: 'txn', received_at: '2026-10-15T15:00:00.000Z', event_id: 'evt-1', amount_text: '$12.34',
    merchant_text: "TRADER JOE'S", occurred_at_text: '2026-10-15T11:00:00-04:00', shortcut_version: '1', rejected_count: '' });
  assert.equal(t.lock.held, false, '锁已释放');
});

test('手动运行快捷指令（金额、商家、时间都为空）也照常写入一行（D4）', () => {
  const t = loadInbox();
  assert.deepEqual(t.post({ event_id: 'manual-1', amount_text: '', merchant_text: '', occurred_at_text: '' }).res, { ok: true });
  const r = t.txnRows()[0];
  assert.equal(r.amount_text, '');
  assert.equal(r.merchant_text, '');
});

test('数字类型的金额和 event_id 按文字保存；对象、数组、布尔值当作空', () => {
  const t = loadInbox();
  t.post({ event_id: 123456, amount_text: 12.34, merchant_text: { x: 1 }, occurred_at_text: ['a'], shortcut_version: true });
  const r = t.txnRows()[0];
  assert.equal(r.event_id, '123456');
  assert.equal(r.amount_text, '12.34');
  assert.equal(r.merchant_text, '');
  assert.equal(r.occurred_at_text, '');
});

// ---------------- 口令 ----------------

test('口令错误：返回 unauthorized，不写入、不读表、不拿锁', () => {
  const t = loadInbox();
  for (const token of ['wrong', TEST_TOKEN + 'x', TEST_TOKEN.slice(0, -1), '', null, 123, undefined]) {
    const body = { event_id: 'evt-x', amount_text: '$1.00' };
    if (token !== undefined) body.token = token;
    const contents = JSON.stringify(body);
    const out = JSON.parse(t.ctx.doPost({ postData: { contents } }).getContent());
    assert.deepEqual(out, { ok: false, reason: 'unauthorized' }, String(token));
  }
  assert.equal(t.rows().length, 0);
  assert.equal(t.lock.attempts, 0, '口令错误时不拿锁，也不占用执行时间');
});

test('脚本属性中没有口令或口令太短（< 24 字符）：一律拒绝，即使请求里的口令与之相同', () => {
  const t = loadInbox({ token: null });
  assert.deepEqual(t.post({ token: '', event_id: 'a' }).res, { ok: false, reason: 'unauthorized' });
  const short = loadInbox({ token: 'short-token' });
  assert.deepEqual(short.post({ token: 'short-token', event_id: 'a' }).res, { ok: false, reason: 'unauthorized' });
  assert.equal(short.rows().length, 0);
});

test('口令比较是固定时间写法：不论第几位不同，比较的字符数都相同', () => {
  const t = loadInbox();
  const src = fs.readFileSync(path.join(INBOX_DIR, 'core.js'), 'utf8');
  const fn = src.slice(src.indexOf('function safeEqual_'), src.indexOf('function cleanIngestText_'));
  assert.doesNotMatch(fn, /return false|break|===\s*b|!==/, '循环中不能提前退出');
  assert.equal(t.ctx.safeEqual_('abc', 'abc'), true);
  assert.equal(t.ctx.safeEqual_('abd', 'abc'), false);
  assert.equal(t.ctx.safeEqual_('ab', 'abc'), false);
  assert.equal(t.ctx.safeEqual_('abcd', 'abc'), false);
  assert.equal(t.ctx.safeEqual_('', 'abc'), false);
});

test('口令错误的请求不计入限流：9 笔正常 + 20 次错误口令之后，第 10 笔仍被接受、第 11 笔被拒', () => {
  const t = loadInbox();
  for (let i = 1; i <= 9; i++) { assert.equal(t.pay('evt-' + i).ok, true); t.advance(60000); }
  for (let i = 0; i < 20; i++) assert.equal(t.post({ token: 'nope', event_id: 'bad-' + i }).res.reason, 'unauthorized');
  assert.equal(t.pay('evt-10').ok, true);
  assert.deepEqual(t.pay('evt-11'), { ok: false, reason: 'rate_limited' });
  assert.equal(t.txnRows().length, 10);
});

// ---------------- 正文大小、格式、字段 ----------------

test('正文超过 4 KB 拒绝且不写入；正好 4 KB 可以；按 UTF-8 字节数计算（中文 3 字节）', () => {
  const t = loadInbox();
  const base = JSON.stringify({ token: TEST_TOKEN, event_id: 'evt-big', merchant_text: '' });
  const exact = base.replace('"merchant_text":""', '"merchant_text":"' + 'x'.repeat(4096 - base.length) + '"');
  assert.equal(Buffer.byteLength(exact), 4096);
  assert.deepEqual(t.post(exact, { raw: true }).res, { ok: true });
  const over = exact.replace('"merchant_text":"', '"merchant_text":"y');
  assert.equal(Buffer.byteLength(over), 4097);
  assert.deepEqual(t.post(over, { raw: true }).res, { ok: false, reason: 'too_large' });
  const cjk = JSON.stringify({ token: TEST_TOKEN, event_id: 'evt-cjk', merchant_text: '商'.repeat(1400) });
  assert.ok(cjk.length < 4096 && Buffer.byteLength(cjk) > 4096);
  assert.deepEqual(t.post(cjk, { raw: true }).res, { ok: false, reason: 'too_large' });
  assert.equal(t.txnRows().length, 1);
  assert.equal(t.txnRows()[0].merchant_text.length, 200, '超长商家截断到 200 字符');
});

test('不是 JSON、JSON 数组、空正文、没有 postData：bad_request，不写入，日志里没有正文', () => {
  const t = loadInbox();
  const secret = 'SECRET-BODY-' + TEST_TOKEN;
  for (const raw of ['not json ' + secret, '[1,2]', '"str"', 'null', '']) {
    assert.deepEqual(t.post(raw, { raw: true }).res, { ok: false, reason: 'bad_request' }, raw);
  }
  assert.deepEqual(JSON.parse(t.ctx.doPost(undefined).getContent()), { ok: false, reason: 'bad_request' });
  assert.deepEqual(JSON.parse(t.ctx.doPost({}).getContent()), { ok: false, reason: 'bad_request' });
  assert.equal(t.rows().length, 0);
  assert.ok(!t.logs.some((l) => l.includes('SECRET-BODY') || l.includes(TEST_TOKEN)));
});

test('event_id 缺少、为空或超过 100 字符：bad_request；控制字符被去掉；文本截断到 200 字符', () => {
  const t = loadInbox();
  assert.equal(t.post({ amount_text: '$1' }).res.reason, 'bad_request');
  assert.equal(t.post({ event_id: '   ' }).res.reason, 'bad_request');
  assert.equal(t.post({ event_id: 'e'.repeat(101) }).res.reason, 'bad_request');
  assert.equal(t.post({ event_id: { a: 1 } }).res.reason, 'bad_request');
  assert.equal(t.rows().length, 0);
  assert.equal(t.post({ event_id: 'e'.repeat(100), merchant_text: 'A\nB\tC\u0000D', amount_text: '9'.repeat(300) }).res.ok, true);
  const r = t.txnRows()[0];
  assert.equal(r.merchant_text, 'A B C D');
  assert.equal(r.amount_text.length, 200);
});

test('公式注入防护：所有写入的文字都以单引号开头（= + - @ 开头的内容按纯文字保存）', () => {
  const t = loadInbox();
  const evil = ['=IMPORTXML("http://x","//a")', '+1+2', '-3', '@SUM(A1)', '2026-01-01', '12.34'];
  evil.forEach((v, i) => t.pay('evt-' + i, { merchant_text: v, amount_text: v }));
  assert.equal(t.appended.length, evil.length);
  t.appended.forEach((vals) => {
    vals.slice(0, 7).forEach((v) => { if (v !== '') assert.ok(String(v).startsWith("'"), '必须以单引号开头：' + v); });
  });
  // 读出来是原样文字（假表格按 Google 表格的规则去掉单引号），没有被当成公式、日期或数字
  assert.deepEqual(t.txnRows().map((r) => r.merchant_text), evil);
  assert.ok(t.txnRows().every((r) => typeof r.amount_text === 'string'));
});

// ---------------- 锁 ----------------

test('拿不到脚本锁：返回 busy，不写入', () => {
  const t = loadInbox();
  t.lock.allow = false;
  assert.deepEqual(t.pay('evt-1'), { ok: false, reason: 'busy' });
  assert.equal(t.rows().length, 0);
  t.lock.allow = true;
  assert.deepEqual(t.pay('evt-1'), { ok: true }, '快捷指令 3 秒后用同一个 event_id 重试');
  assert.equal(t.txnRows().length, 1);
});

test('inbox 工作表缺失：返回 not_ready，并释放锁', () => {
  const t = loadInbox({ setup: false });
  assert.deepEqual(t.pay('evt-1'), { ok: false, reason: 'not_ready' });
  assert.equal(t.lock.held, false);
});

test('意外错误：只返回 {ok:false, reason:"error"}，日志只记错误类型，不记内容', () => {
  const t = loadInbox();
  t.sheet().appendRow = () => { throw new Error('boom ' + TEST_TOKEN); };
  assert.deepEqual(t.pay('evt-1', { merchant_text: 'PRIVATE-MERCHANT' }), { ok: false, reason: 'error' });
  assert.ok(!t.logs.some((l) => l.includes(TEST_TOKEN) || l.includes('PRIVATE-MERCHANT') || l.includes('boom')));
  assert.equal(t.lock.held, false, '出错时也释放锁');
});

// ---------------- 重试与去重 ----------------

test('同一个 event_id 重复发送：只写一行；已达上限时重试已接受的 event_id 仍返回 ok', () => {
  const t = loadInbox();
  assert.deepEqual(t.pay('evt-same'), { ok: true });
  assert.deepEqual(t.pay('evt-same'), { ok: true });
  assert.equal(t.txnRows().length, 1);
  for (let i = 2; i <= 10; i++) t.pay('evt-' + i);
  assert.equal(t.pay('evt-11').reason, 'rate_limited');
  assert.deepEqual(t.pay('evt-same'), { ok: true }, '重试不会被当成第 11 笔');
  assert.equal(t.txnRows().length, 10);
});

// ---------------- 限流（spec 5.3） ----------------

test('每小时：第 10 笔接受、第 11 笔拒绝并写一条限流标记行；标记行不含交易内容', () => {
  const t = loadInbox();
  for (let i = 1; i <= 10; i++) { assert.deepEqual(t.pay('evt-' + i), { ok: true }, '第 ' + i + ' 笔'); t.advance(1000); }
  assert.deepEqual(t.pay('evt-11', { merchant_text: 'SHOULD-NOT-BE-SAVED' }), { ok: false, reason: 'rate_limited' });
  assert.equal(t.txnRows().length, 10);
  const m = t.markerRows();
  assert.equal(m.length, 1);
  assert.equal(m[0].received_at, t.nowIso());
  assert.equal(m[0].rejected_count, 1);
  assert.equal(m[0].event_id, '');
  assert.ok(!JSON.stringify(t.rows()).includes('SHOULD-NOT-BE-SAVED'));
});

test('限流标记每小时最多一条，被拒次数累加；超过 1 小时后再被拒才写新的标记行', () => {
  const t = loadInbox();
  for (let i = 1; i <= 10; i++) t.pay('evt-' + i);
  t.pay('r-1'); t.advance(10 * 60000);
  t.pay('r-2'); t.advance(10 * 60000);
  t.pay('r-3');
  let m = t.markerRows();
  assert.equal(m.length, 1);
  assert.equal(m[0].rejected_count, 3);
  // 第一条标记写下 1 小时零 1 分钟后：前 10 笔也已过了 1 小时，小时上限恢复；用每日上限来制造新的拒绝
  t.advance(41 * 60000);
  for (let i = 12; i <= 30; i++) { t.pay('evt-' + i); t.advance(1000); }  // 再 19 笔：这一小时 10 笔已满
  assert.equal(t.txnRows().length, 20);
  t.advance(H);
  for (let i = 31; i <= 40; i++) t.pay('evt-' + i);
  assert.equal(t.txnRows().length, 30, '24 小时内共 30 笔');
  assert.deepEqual(t.pay('evt-41'), { ok: false, reason: 'rate_limited' });
  m = t.markerRows();
  assert.ok(m.length >= 2, '超过 1 小时后的新拒绝写新的标记行');
  const times = m.map((r) => Date.parse(r.received_at)).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= H, '两条标记行至少相隔 1 小时');
});

test('每天：第 30 笔接受、第 31 笔拒绝；中间穿插 24 条限流标记行（以及更早的行）时仍然有效', () => {
  const t = loadInbox({ now: '2026-10-15T15:00:00.000Z' });
  const now = Date.parse('2026-10-15T15:00:00.000Z');
  // 30 小时前的旧行（不在 24 小时内）
  for (let i = 0; i < 20; i++) t.seed('txn', iso(now - 30 * H - i * 60000), 'old-' + i);
  // 过去 24 小时：每小时一条标记行（共 24 条），和 29 笔交易穿插（最近 1 小时内只有 1 笔，不触发小时上限）
  let n = 0;
  for (let h = 23; h >= 0; h--) {
    t.seed('rate_limited', iso(now - h * H - 50 * 60000 + 1), '', 1);
    const per = h === 0 ? 1 : (n < 28 ? (h % 2 === 0 ? 2 : 1) : 0);
    for (let k = 0; k < per && n < 29; k++) { t.seed('txn', iso(now - h * H - 20 * 60000 - k * 60000), 'day-' + n); n++; }
  }
  while (n < 29) { t.seed('txn', iso(now - 12 * H - n * 1000), 'day-' + n); n++; }
  const inDay = t.txnRows().filter((r) => Date.parse(r.received_at) > now - 24 * H).length;
  assert.equal(inDay, 29);
  assert.equal(t.markerRows().length, 24);
  assert.ok(t.rows().length > 60, '表中总行数超过 60，只看最后 60 行');
  assert.deepEqual(t.pay('evt-30'), { ok: true }, '第 30 笔接受');
  assert.deepEqual(t.pay('evt-31'), { ok: false, reason: 'rate_limited' }, '第 31 笔拒绝');
});

test('恰好 1 小时前、恰好 24 小时前的行不计入', () => {
  const now = Date.parse('2026-10-15T15:00:00.000Z');
  const a = loadInbox({ now: iso(now) });
  for (let i = 0; i < 10; i++) a.seed('txn', iso(now - H), 'h-' + i);
  assert.deepEqual(a.pay('evt-new'), { ok: true }, '恰好 1 小时前的 10 笔不算在这一小时');
  const b = loadInbox({ now: iso(now) });
  for (let i = 0; i < 10; i++) b.seed('txn', iso(now - H + 1), 'h-' + i);
  assert.deepEqual(b.pay('evt-new'), { ok: false, reason: 'rate_limited' }, '差 1 毫秒满 1 小时的仍算');
  const c = loadInbox({ now: iso(now) });
  for (let i = 0; i < 30; i++) c.seed('txn', iso(now - 24 * H), 'd-' + i);
  assert.deepEqual(c.pay('evt-new'), { ok: true }, '恰好 24 小时前的 30 笔不算');
  const d = loadInbox({ now: iso(now) });
  for (let i = 0; i < 30; i++) d.seed('txn', iso(now - 24 * H + 1 + i), 'd-' + i);
  assert.deepEqual(d.pay('evt-new'), { ok: false, reason: 'rate_limited' });
});

test('把 occurred_at_text 伪造成很早的时间也绕不过限流（只看服务器的 received_at）', () => {
  const t = loadInbox();
  for (let i = 1; i <= 10; i++) assert.equal(t.pay('evt-' + i, { occurred_at_text: '2001-01-01T00:00:00Z' }).ok, true);
  assert.deepEqual(t.pay('evt-11', { occurred_at_text: '1999-01-01T00:00:00Z' }), { ok: false, reason: 'rate_limited' });
  assert.ok(t.txnRows().every((r) => r.received_at === t.nowIso()));
});

test('更新标记行之前会再核对那一行：行号已经变了（被清理过旧行）就不写，改为新写一条标记行', () => {
  const t = loadInbox();
  const env = t.ctx.inboxEnv_();
  t.seed('rate_limited', t.nowIso(), '', 2);
  const rowIndex = t.sheet().rows.length;
  assert.equal(env.updateMarker(rowIndex, Date.parse(t.nowIso()) + 1, 3), false, '时间不对：不写');
  assert.equal(env.updateMarker(rowIndex + 5, Date.parse(t.nowIso()), 3), false, '行号超出：不写');
  assert.equal(t.markerRows()[0].rejected_count, 2);
  assert.equal(env.updateMarker(rowIndex, Date.parse(t.nowIso()), 3), true);
  assert.equal(t.markerRows()[0].rejected_count, 3);
});

test('返回值只包含 ok 和 reason，绝不返回表格内容；日志不含口令和正文', () => {
  const t = loadInbox();
  const results = [t.pay('evt-a', { merchant_text: 'PRIVATE-A' }), t.post({ token: 'x', event_id: 'b' }).res,
    t.post('{', { raw: true }).res];
  for (let i = 0; i < 12; i++) results.push(t.pay('evt-r' + i, { merchant_text: 'PRIVATE-B' }));
  results.forEach((r) => assert.ok(Object.keys(r).every((k) => k === 'ok' || k === 'reason'), JSON.stringify(r)));
  assert.ok(!t.logs.some((l) => l.includes(TEST_TOKEN) || l.includes('PRIVATE')));
  const src = fs.readFileSync(path.join(INBOX_DIR, 'inbox.js'), 'utf8') + fs.readFileSync(path.join(INBOX_DIR, 'core.js'), 'utf8');
  assert.doesNotMatch(src, /console\.\w+\([^;]*\+\s*(contents|body|token|parsed|err\.message|e\.message)\b/, '日志里不能出现正文、口令或错误详情');
});
