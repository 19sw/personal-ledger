'use strict';
/**
 * 外卖收据的入口函数（jobs.js / web.js / gmail.js）走真实路径：假的高级 Gmail 服务 + 假表格 + 假定时器。
 * 两阶段开启（installTriggers 不开启、enable/disable 幂等）、pollReceipts、dryRunReceipts（不写任何东西、日志不含邮件内容）、
 * 打开网页不受 Gmail 影响、清单只加了高级 Gmail 服务。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBackend } = require('./helpers/harness');
const { apiMessage, fakeGmail } = require('./helpers/gmail');
const { MAIN } = require('./helpers/gas');
const F = require('./fixtures/synthetic-mail');

const recent = (minAgo = 5) => new Date(Date.now() - minAgo * 60000).toISOString();

function backend({ messages = [], enabled = false, gmail = true, logs } = {}) {
  const gm = fakeGmail(messages.map(apiMessage));
  const props = enabled ? { GMAIL_POLLING_ENABLED_AT: recent(1) } : {};
  const cons = logs ? { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), info: () => {} } : undefined;
  const b = createBackend({ props, gmail: gmail ? gm.service : undefined, console: cons });
  const repo = () => b.g.sheetRepo_(b.ss);
  const pollTriggers = () => b.scriptApp.triggers.filter((t) => t.getHandlerFunction() === 'pollReceipts');
  return { b, gm, repo, pollTriggers };
}

function snapshot(b) {
  return JSON.stringify(Object.fromEntries(Object.entries(b.ss.sheets).map(([k, v]) => [k, v.rows])));
}

test('installTriggers 不开启外卖收据轮询；enableReceiptPolling 重复运行也只有一个 5 分钟定时器；disable 幂等', () => {
  const { b, pollTriggers } = backend();
  b.g.installTriggers();
  assert.deepEqual(b.scriptApp.triggers.map((t) => t.getHandlerFunction()).sort(), ['dailyCleanup', 'processInbox']);
  assert.equal(b.props.GMAIL_POLLING_ENABLED_AT, undefined);
  b.g.enableReceiptPolling();
  b.g.enableReceiptPolling();
  assert.equal(pollTriggers().length, 1);
  assert.equal(pollTriggers()[0].spec.everyMinutes, 5);
  assert.ok(!isNaN(Date.parse(b.props.GMAIL_POLLING_ENABLED_AT)));
  b.g.installTriggers();
  assert.equal(pollTriggers().length, 1, 'installTriggers 不动 pollReceipts 定时器');
  assert.equal(b.scriptApp.triggers.length, 3);
  b.g.disableReceiptPolling();
  b.g.disableReceiptPolling();
  assert.equal(pollTriggers().length, 0);
  assert.equal(b.props.GMAIL_POLLING_ENABLED_AT, undefined);
  assert.equal(b.scriptApp.triggers.length, 2, 'Apple Pay 和每日清理的定时器不受影响');
});

test('enableReceiptPolling：没有启用高级 Gmail 服务、或还没重新运行 setupLedger 时拒绝开启', () => {
  const x = backend({ gmail: false });
  assert.throws(() => x.b.g.enableReceiptPolling(), /高级 Gmail 服务/);
  assert.equal(x.pollTriggers().length, 0);
  assert.equal(x.b.props.GMAIL_POLLING_ENABLED_AT, undefined);
  const y = backend();
  delete y.b.ss.sheets.gmail_pending;
  assert.throws(() => y.b.g.enableReceiptPolling(), /setupLedger/);
  assert.equal(y.pollTriggers().length, 0);
});

test('pollReceipts：没有开启时什么都不做（不拿锁、不读 Gmail、不打开账本）', () => {
  const { b, gm } = backend({ messages: [F.ddReceipt({ at: recent() })] });
  const opens = b.ledgerOpens();
  assert.deepEqual(JSON.parse(JSON.stringify(b.g.pollReceipts())), { enabled: false });
  assert.equal(gm.calls.list.length + gm.calls.get.length, 0);
  assert.equal(b.lock.attempts, 0);
  assert.equal(b.ledgerOpens(), opens);
});

test('pollReceipts：开启后读取 Gmail API 格式的邮件（base64url 正文、带附件）并入账；日志只有数量和代码', () => {
  const logs = [];
  const { b, gm, repo } = backend({ enabled: true, logs,
    messages: [F.ddReceipt({ at: recent(8) }), F.uberRide({ at: recent(7), footer: true }), F.uberUnknownWithAmount({ at: recent(6) }), F.genericReceipt({ at: recent(5) })] });
  const r = JSON.parse(JSON.stringify(b.g.pollReceipts()));
  assert.equal(r.created, 3);
  assert.equal(r.pending_added, 1);
  assert.equal(r.read, 4);
  assert.equal(gm.calls.list.length, 1);
  assert.match(gm.calls.list[0].q, /^newer_than:3d \(\{from:\(doordash\.com\) from:\(uber\.com\)/);
  assert.equal(gm.calls.list[0].maxResults, 50);
  assert.ok(gm.calls.get.every((c) => c.opts.format === 'full' && c.user === 'me'));
  const es = repo().list('entries');
  assert.deepEqual(JSON.parse(JSON.stringify(es.map((e) => [e.merchant, e.amount_cents]).sort())), [['DoorDash', 2345], ['Uber', 1875], ['Uber', 2210]]);
  assert.equal(repo().list('gmail_pending').length, 1);
  // 第二轮：都处理过了，不再读取
  b.g.pollReceipts();
  assert.equal(gm.calls.get.length, 4);
  const all = logs.join('\n');
  for (const bad of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'doordash.com>', 'Order Confirmation', '23.45', 'dd0000000001']) {
    assert.equal(all.includes(bad), false, '日志里不应出现：' + bad);
  }
  assert.match(all, /pollReceipts: 列出 4，读取 4，入账 3/);
  // 小助手：有新入账和待查看邮件 → 规则运行过
  assert.ok(repo().list('assistant_messages').some((m) => m.skill_id === 'pending_items'));
});

test('pollReceipts：拿不到锁就跳过本轮（不读 Gmail、不抛错）；Gmail 授权失效 → 记录 AUTH_REVOKED，不抛错', () => {
  const { b, gm, repo } = backend({ enabled: true, messages: [F.ddReceipt({ at: recent() })] });
  b.lock.allow = false;
  assert.equal(b.g.pollReceipts().skipped, true);
  assert.equal(gm.calls.list.length, 0);
  b.lock.allow = true;
  gm.fail.list = new Error('Invalid Credentials (401)');
  assert.equal(b.g.pollReceipts().error_code, 'AUTH_REVOKED');
  assert.equal(repo().list('channel_status').find((r) => r.channel === 'gmail').last_error_code, 'AUTH_REVOKED');
});

test('pollReceipts：开启了但高级 Gmail 服务不见了 → GMAIL_SERVICE_MISSING，不抛错', () => {
  const { b, repo } = backend({ enabled: true, gmail: false });
  assert.equal(b.g.pollReceipts().error_code, 'GMAIL_SERVICE_MISSING');
  assert.equal(repo().list('channel_status').find((r) => r.channel === 'gmail').last_error_code, 'GMAIL_SERVICE_MISSING');
});

test('打开网页：Gmail 未开启、授权失效或额度用完都不影响；打开网页时不读 Gmail', () => {
  const off = backend({ messages: [F.ddReceipt({ at: recent() })] });
  const boot = JSON.parse(JSON.stringify(off.b.g.api_bootstrap()));
  assert.equal(boot.gmail.enabled, false);
  assert.deepEqual(boot.gmail.warnings, []);
  assert.equal(off.gm.calls.list.length + off.gm.calls.get.length, 0);

  const on = backend({ enabled: true, messages: [F.ddReceipt({ at: recent() })] });
  on.gm.fail.list = new Error('Quota exceeded');
  on.b.g.pollReceipts();
  const boot2 = JSON.parse(JSON.stringify(on.b.g.api_bootstrap()));
  assert.match(boot2.gmail.warnings.join(), /读取额度/);
  assert.equal(on.gm.calls.list.length, 1, '只有 pollReceipts 读过 Gmail，打开网页没有');
});

test('dryRunReceipts：不开启也能运行；只写日志（不含主题、正文、地址）；不打开账本、不写任何东西', () => {
  const logs = [];
  const msgs = [F.ddReceipt({ at: recent(30) }), F.ddPromo({ at: recent(20) }), F.ueReceipt({ at: recent(10) }), F.uberRide({ at: recent(9), footer: true })];
  const { b, gm } = backend({ messages: msgs, logs });
  const before = snapshot(b);
  const props = JSON.stringify(b.props);
  const triggers = b.scriptApp.triggers.length;
  const opens = b.ledgerOpens();
  const r = JSON.parse(JSON.stringify(b.g.dryRunReceipts('ubereats')));
  assert.deepEqual(r, [{ platform: 'ubereats', count: 2 }]);
  assert.equal(gm.calls.list[0].q, '{from:(uber.com)}');
  assert.equal(gm.calls.list[0].maxResults, 10);
  const all = JSON.parse(JSON.stringify(b.g.dryRunReceipts()));
  assert.deepEqual(all.map((x) => x.platform), ['doordash', 'uber', 'ubereats'], '不填平台 = 三个平台依次试运行');
  assert.equal(snapshot(b), before, '账本表格没有任何变化');
  assert.equal(JSON.stringify(b.props), props);
  assert.equal(b.scriptApp.triggers.length, triggers);
  assert.equal(b.ledgerOpens(), opens, '没有打开账本');
  const text = logs.join('\n');
  assert.match(text, /uber\.com \| receipt \| 31\.20 USD \| 订单号:有 \| 总额标签:Total/);
  assert.match(text, /uber\.com \| receipt \| 18\.75 USD \| 订单号:无 \| 行程总额标签:Total/, '打车显示命中的总额标签');
  for (const bad of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'Uber Eats order', 'Thanks for riding', 'uber@', 'f00d0000']) {
    assert.equal(text.includes(bad), false, '日志里不应出现：' + bad);
  }
  assert.throws(() => b.g.dryRunReceipts('grubhub'), /doordash、uber、ubereats/);
});

test('中文收据 smoke：G1 共享域名只读；G2 经 MIME 解码入账正确分类，重复轮询不重复记账', () => {
  const logs = [];
  const ride = F.uberChineseRide({ split: true, at: recent(4) });
  const eats = Object.assign({}, F.uberChineseRide({ id: 'ue00000000c1', at: recent(3) }),
    { from: 'Uber Eats <receipts@uber.com>', subject: '您的 Uber Eats 订单收据' });
  const { b, gm, repo } = backend({ logs, messages: [ride, eats].map(m => Object.assign({}, m, { at: new Date(m.internalDate).toISOString() })) });
  const before = snapshot(b);
  b.g.dryRunReceipts();
  assert.equal(snapshot(b), before);
  assert.equal(b.props.GMAIL_POLLING_ENABLED_AT, undefined);
  const lines = logs.join('\n');
  assert.match(lines, /27\.60 USD \| 订单号:无 \| 行程总额标签:总计/);
  assert.match(lines, /27\.60 USD \| 订单号:无 \| 总额标签:总计/);
  for (const m of [ride, eats]) assert.equal(lines.includes(m.subject), false);
  b.g.enableReceiptPolling();
  assert.equal(b.g.pollReceipts().created, 2);
  const entries = repo().list('entries');
  const categories = repo().list('categories');
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(e => [e.platform, e.amount_cents,
    categories.find(c => c.id === e.category_id).name]).sort())),
  [['uber', 2760, '交通'], ['ubereats', 2760, '餐饮']]);
  const readCount = gm.calls.get.length;
  assert.equal(b.g.pollReceipts().created, 0);
  assert.equal(gm.calls.get.length, readCount, '处理过的邮件不再读取');
  assert.equal(repo().list('entries').length, 2);
  assert.equal(repo().list('processed_sources').filter(p => p.source_key.startsWith('gmail:msg:')).length, 2);
});

test('中文收据 smoke：冲突总额、非美元、空总额后的小计进待查看，不创建账目', () => {
  const cases = ['总计 US$27.60\nTotal US$29.60', '总计 CA$27.60', '总计\n小计 $21'];
  const messages = cases.map((text, i) => Object.assign({}, F.uberChineseRide({ id: 'ur00000000d' + i, at: recent(4) }), { html: '', text }));
  const { b, repo } = backend({ enabled: true, messages: messages.map(m => Object.assign({}, m, { at: new Date(m.internalDate).toISOString() })) });
  assert.equal(b.g.pollReceipts().pending_added, 3);
  assert.equal(repo().list('entries').length, 0);
  const pending = repo().list('gmail_pending');
  assert.equal(pending.length, 3);
  assert.ok(pending.every(m => m.amount_cents === null));
  assert.deepEqual(Array.from(pending, m => m.reason).sort(), ['CURRENCY_UNKNOWN', 'MULTIPLE_TOTALS', 'TOTAL_NOT_FOUND']);
  assert.equal(b.g.pollReceipts().pending_added, 0);
  assert.equal(repo().list('gmail_pending').length, 3);
});

test('正文解码：base64url 文字（补 = 号）和字节数组两种写法都能还原 UTF-8', () => {
  const { b } = backend();
  const s = '实付金额：$26.80';
  assert.equal(b.g.decodeGmailBody_(Buffer.from(s).toString('base64url')), s);
  assert.equal(b.g.decodeGmailBody_(Array.from(Buffer.from(s))), s);
  assert.equal(b.g.decodeGmailBody_(''), '');
});

test('网页 api_markMailReviewed：只把那一封邮件标为已查看；编号不对报错', () => {
  const { b, repo } = backend({ enabled: true, messages: [F.genericReceipt({ at: recent() })] });
  b.g.pollReceipts();
  assert.equal(JSON.parse(JSON.stringify(b.g.api_bootstrap())).gmail.pending_count, 1);
  const r = JSON.parse(JSON.stringify(b.g.api_markMailReviewed('un0000000001')));
  assert.deepEqual(r, { ok: true, pending_count: 0 });
  assert.ok(repo().list('gmail_pending')[0].reviewed_at);
  assert.throws(() => b.g.api_markMailReviewed('../../etc'), /邮件编号不正确/);
});

test('待查看动作：手动记账保存 Gmail 来源键并标已查看，重复提交返回原账目', () => {
  const { b, repo } = backend({ enabled: true, messages: [F.genericReceipt({ at: recent() })] });
  b.g.pollReceipts();
  const row = repo().list('gmail_pending')[0];
  const cat = repo().list('categories').find((c) => c.name === '餐饮');
  const input = { type: 'expense', amount: '7.25', category_id: cat.id, local_datetime: b.g.api_bootstrap().now_local,
    merchant: row.sender_domain, note: '', pending_message_id: row.message_id };
  const first = b.g.api_saveEntry(input);
  const second = b.g.api_saveEntry(input);
  assert.equal(first.id, second.id);
  assert.equal(repo().list('entries').length, 1);
  assert.deepEqual([repo().list('entries')[0].channel, repo().list('entries')[0].source_key], ['gmail_receipt', 'gmail:msg:' + row.message_id]);
  assert.ok(repo().list('gmail_pending')[0].reviewed_at);
});

test('待查看动作：以后自动记写入名单并记这一封；静音后隐藏历史并在 Gmail get 前排除新邮件', () => {
  const first = F.genericReceipt({ id: 'un0000000011', domain: 'auto.example', at: recent() });
  const muted = F.genericReceipt({ id: 'un0000000012', domain: 'quiet.example', at: recent() });
  const { b, gm, repo } = backend({ enabled: true, messages: [first, muted] });
  b.g.pollReceipts();
  const cat = repo().list('categories').find((c) => c.name === '餐饮');
  b.g.api_addMailSenderAndRecord('un0000000011', cat.id);
  b.g.api_addMailSenderAndRecord('un0000000011', cat.id);
  assert.equal(repo().list('entries').length, 1);
  assert.equal(repo().list('mail_senders').find((s) => s.domain === 'auto.example').mode, 'auto');
  assert.ok(repo().list('gmail_pending').find((m) => m.message_id === 'un0000000011').reviewed_at);
  b.g.api_muteMailSender('un0000000012');
  b.g.api_muteMailSender('un0000000012');
  assert.equal(b.g.api_bootstrap().gmail.pending_count, 0);
  const next = F.genericReceipt({ id: 'un0000000013', domain: 'quiet.example', at: recent() });
  gm.add(apiMessage(next));
  const beforeGets = gm.calls.get.length;
  b.g.pollReceipts();
  assert.equal(gm.calls.get.length, beforeGets, 'muted sender excluded before Messages.get');
});

test('以后自动记：唯一金额或类别无效时拒绝操作，不能留下 auto 商家行', () => {
  const { b, repo } = backend();
  const now = new Date();
  const pending = (message_id, domain, amount_cents) => repo().insert('gmail_pending', {
    message_id, platforms: '', received_at: now.toISOString(), sender_domain: domain,
    amount_cents, reason: 'UNLISTED', reviewed_at: null, created_at: now.toISOString()
  });
  const categoryId = repo().list('categories').find((c) => c.name === '餐饮').id;
  pending('un0000000031', 'missing.example', null);
  assert.throws(() => b.g.svcAddSenderAndRecordPending(repo(), 'un0000000031', categoryId, now, () => 'unused'), /唯一金额/);
  assert.throws(() => b.g.api_addMailSenderAndRecord('un0000000031', categoryId), /唯一金额/);
  assert.equal(repo().list('mail_senders').length, 0, '金额无效不能写名单');
  assert.equal(repo().list('entries').length, 0);

  pending('un0000000032', 'category.example', 725);
  assert.throws(() => b.g.api_addMailSenderAndRecord('un0000000032', 'missing-category'), /有效的支出类别/);
  assert.equal(repo().list('mail_senders').length, 0, '类别无效不能写名单');
  assert.equal(repo().list('entries').length, 0);
});

test('G1 broad dry run：只输出安全字段、写入为零，查询排除平台和名单网域', () => {
  const logs = [];
  const { b, gm } = backend({ messages: [F.genericReceipt({ at: recent() }), F.ddReceipt({ at: recent(2) })], logs });
  const before = snapshot(b);
  const result = b.g.dryRunReceipts('broad');
  assert.equal(result.writes, 0);
  assert.equal(snapshot(b), before);
  assert.match(gm.calls.list[0].q, /-from:\(doordash\.com\)/);
  const log = logs.join('\n');
  assert.match(log, /shop\.example.*7\.25 USD.*UNLISTED/);
  for (const secret of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'Your receipt', 'receipts@shop.example']) assert.equal(log.includes(secret), false);
});

test('清单：只加了高级 Gmail 服务（v1），oauthScopes 不变；代码里不用 GmailApp', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MAIN, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.scriptapp'
  ]);
  assert.deepEqual(manifest.dependencies, { enabledAdvancedServices: [{ userSymbol: 'Gmail', serviceId: 'gmail', version: 'v1' }] });
  const files = [];
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|html)$/.test(n)) files.push(p);
    }
  })(MAIN);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /GmailApp\./, f);
});

test('隐私（静态检查）：外卖收据相关代码的日志语句不引用主题、正文、发件人或邮件对象', () => {
  const files = ['core/receipt_text.js', 'core/receipt_registry.js', 'core/receipt_pipeline.js', 'core/platforms/doordash.js',
    'core/platforms/uber.js', 'core/platforms/ubereats.js', 'gmail.js', 'jobs.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(MAIN, f), 'utf8');
    for (const line of src.split('\n').filter((l) => /console\.(log|warn|error|info)\(/.test(l))) {
      assert.doesNotMatch(line, /subject|\.html|\.text\b|\.from\b|snippet|payload|\bm\.|\bmsg\b|body/i, f + ': ' + line.trim());
    }
  }
  // 试运行唯一写日志的地方是 dryRunLine 的结果
  assert.match(fs.readFileSync(path.join(MAIN, 'jobs.js'), 'utf8'), /var log = function \(line\) \{ console\.log\(line\); \};/);
});

test('消费证据 smoke：广告忽略，真实无姓名收据入账，金额不确定待查看，重复扫描无新增', () => {
  const make = (id, from, subject, text) => F.mail({ id, from, subject, text, at: recent() });
  const msgs = [
    make('ev0000000011', 'Uber <news@uber.com>', 'Sam, something for you', 'Hi Sam\nTotal $30 minimum spend\nSave $10 on your next ride'),
    make('ev0000000012', 'DoorDash <receipts@doordash.com>', 'Payment received', 'Payment received\n实付 US$26.80'),
    make('ev0000000013', 'Uber <receipts@uber.com>', 'Your trip receipt', 'Total $21\nAmount Paid $23'),
    make('ev0000000014', 'Uber Eats <receipts@uber.com>', 'Your order receipt', 'Subtotal $18.00'),
    make('ev0000000015', 'Shop <receipts@safe.example>', 'Sam, save $10 on your next order', 'Total $30'),
    make('ev0000000016', 'Shop <receipts@safe.example>', 'Payment received', 'Payment received\nAmount Paid $17.25'),
    make('ev0000000017', 'Shop <receipts@unknown.example>', 'Payment received', 'Payment received\nAmount Paid $17.25'),
    make('ev0000000018', 'Shop <receipts@safe.example>', 'Your receipt', 'Total\nSubtotal $16.00')
  ];
  const logs = [];
  const { b, repo } = backend({ messages: msgs, logs, enabled: true });
  const category = repo().list('categories').find(c => c.name === '餐饮');
  b.g.upsertMailSender_(repo(), { domain: 'safe.example', mode: 'auto', category_id: category.id }, new Date());
  const before = snapshot(b);
  b.g.dryRunReceipts();
  assert.equal(snapshot(b), before, 'G1 remains read-only');
  b.g.pollReceipts();
  const es = repo().list('entries');
  assert.deepEqual(Array.from(es, e => e.amount_cents).sort((a,b) => a-b), [1725, 2680]);
  assert.deepEqual(Array.from(repo().list('gmail_pending'), m => m.message_id).sort(),
    ['ev0000000013', 'ev0000000014', 'ev0000000017', 'ev0000000018']);
  assert.ok(repo().list('gmail_pending').filter(m => m.message_id !== 'ev0000000017').every(m => m.amount_cents === null));
  b.g.pollReceipts();
  assert.equal(repo().list('entries').length, 2);
  assert.equal(repo().list('gmail_pending').length, 4);
});

test('评审回归 smoke：预估行程、感谢乘坐广告和拆行门槛不写账本；真实收据可含促销页脚', () => {
  const cases = [
    ['Your ride estimate', 'Estimated fare for your upcoming ride\nTotal $30.00'],
    ['您的行程预估', '总计 US$30.00'],
    ['Thank you', 'Thanks for riding with us.\nSave $10 on your next ride\nTotal $30.00'],
    ['Your trip receipt', 'Total\n$30.00\nminimum spend'],
    ['Your trip receipt', 'Total\n$30.00\nor more'],
    ['您的行程收据', '总计\n$30.00\n可享优惠']
  ];
  const outcomes = [];
  for (const [i, [subject, text]] of cases.entries()) {
    const m = F.mail({ id: 'rv000000000' + i, from: 'Uber <news@uber.com>', subject, text, at: recent() });
    const { b, repo } = backend({ messages: [m], enabled: true });
    const r = b.g.pollReceipts();
    outcomes.push([r.created, repo().list('entries').length, repo().list('gmail_pending').length]);
    assert.equal(b.g.pollReceipts().created, 0);
  }
  assert.deepEqual(outcomes, [[0, 0, 1], [0, 0, 1], [0, 0, 0], [0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  for (const [i, subject] of ['Your trip receipt', 'Payment received'].entries()) {
    const m = F.mail({ id: 'rv000000001' + i, from: 'Uber <receipts@uber.com>', subject,
      text: 'Payment received\nTotal US$26.80\nThanks for riding\nSave $10 on your next ride', at: recent() });
    const { b, repo } = backend({ messages: [m], enabled: true });
    assert.equal(b.g.pollReceipts().created, 1);
    assert.equal(repo().list('entries')[0].amount_cents, 2680);
  }
});
