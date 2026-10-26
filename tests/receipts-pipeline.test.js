'use strict';
/**
 * 外卖收据的共用流程（spec 4.2、4.4、6.4–6.7；§10 切片 2）：入账、去重、退款与修订、D7、D16、跨渠道重复、轮询与状态。
 * 内存 repo + 内存 Gmail client；样本全部是手写的合成收据（tests/fixtures/synthetic-mail.js）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas, memoryRepo, idGen, plain } = require('./helpers/gas');
const { memoryClient } = require('./helpers/gmail');
const F = require('./fixtures/synthetic-mail');

const H = 3600000;

function setup(nowIso = '2026-10-15T16:10:00.000Z', { without = [] } = {}) {
  const g = loadGas();
  const repo = memoryRepo(g, { without });
  const newId = idGen('e');
  g.svcEnsureDefaults(repo);
  let now = new Date(nowIso);
  const t = {
    g, repo, newId,
    platforms: g.receiptPlatforms(),
    now: () => now,
    setNow(iso) { now = new Date(iso); },
    handle(m, platforms = t.platforms) { return plain(Object.assign({}, g.svcHandleReceiptMessage(repo, m, platforms, now, newId), { entry: null })); },
    entries: () => repo.list('entries'),
    live: () => repo.list('entries').filter((e) => !e.deleted_at),
    source: (key) => repo.list('processed_sources').find((p) => p.source_key === key),
    pending: () => repo.list('gmail_pending').filter((r) => !r.reviewed_at),
    dining: () => repo.list('categories').find((c) => c.name === '餐饮').id,
    transport: () => repo.list('categories').find((c) => c.name === '交通').id,
    poll(client, platforms = t.platforms) { return plain(g.svcPollReceipts(repo, client, now, platforms, newId)); },
    applePay(merchant, amountText, receivedIso) {
      return plain(g.svcProcessInbox(repo, [{ row_index: 2, row_type: 'txn', received_at: receivedIso || now.toISOString(),
        event_id: 'evt-' + merchant + '-' + amountText, amount_text: amountText, merchant_text: merchant, occurred_at_text: '',
        shortcut_version: '1', rejected_count: null }], now, newId));
    }
  };
  return t;
}

// 每个平台的样本：收据（有订单号）、同订单改小费后的收据、退款、促销、缺少订单号的收据
const PLATFORMS = {
  doordash: {
    name: 'DoorDash', receipt: F.ddReceipt, cents: 2345,
    revised: (o) => F.ddReceipt(Object.assign({ id: 'dd00000000r1', total: '$25.45', tip: '$5.00' }, o)),
    refund: F.ddRefund, refundCents: 500, promo: F.ddPromo,
    noRef: (o) => F.ddReceiptNoRef(o)
  },
  ubereats: {
    name: 'Uber Eats', receipt: F.ueReceipt, cents: 3120,
    revised: (o) => F.ueReceipt(Object.assign({ id: 'ue00000000r1', total: '$33.20' }, o)),
    refund: F.ueRefund, refundCents: 850, promo: F.uberEatsPromo,
    noRef: (o) => F.ueReceipt(Object.assign({ orderId: null }, o))
  }
};

function stripRef(m) {
  return Object.assign({}, m, { html: m.html.replace(/订单号 Order No\.：<\/td><td align="right">[^<]*/, '备注：</td><td align="right">none') });
}

for (const [pid, S] of Object.entries(PLATFORMS)) {
  test(`${S.name}：收据 → 一笔餐饮支出，金额为实付总额，商家为平台名，来源 Gmail，记下凭据和订单键`, () => {
    const t = setup();
    const m = S.receipt({ at: '2026-10-15T16:00:00.000Z' });
    const r = t.handle(m);
    assert.equal(r.outcome, 'created');
    const e = t.entries()[0];
    assert.equal(e.amount_cents, S.cents);
    assert.equal(e.type, 'expense');
    assert.equal(e.merchant, S.name);
    assert.equal(e.channel, 'gmail_receipt');
    assert.equal(e.platform, pid);
    assert.equal(e.category_id, t.dining());
    assert.equal(e.source_key, 'gmail:msg:' + m.id);
    assert.ok(e.order_ref);
    assert.equal(e.occurred_at, '2026-10-15T16:00:00.000Z', '时间 = 邮件到达时间');
    assert.equal(e.month_ny, '2026-10');
    assert.equal(t.source('gmail:msg:' + m.id).outcome, 'created');
    assert.equal(t.source(`order:${pid}:${e.order_ref}:receipt`).entry_id, e.id);
    assert.equal(t.g.channelLabel(e), 'Gmail（' + S.name + '）');
    assert.ok(t.repo.list('checkins').length === 1, '自动入账也算打卡');
    assert.ok(t.repo.list('month_meta').some((x) => x.month === '2026-10'), '更新月份的最后更新时间');
  });

  test(`${S.name}：退款 → 负支出，关联原订单，类别与原账目相同，原账目不变`, () => {
    const t = setup();
    t.handle(S.receipt());
    const r = t.handle(S.refund());
    assert.equal(r.outcome, 'refund_created');
    const [orig, ref] = t.entries();
    assert.equal(ref.amount_cents, -S.refundCents);
    assert.equal(ref.is_refund, true);
    assert.equal(ref.refund_of, orig.id);
    assert.equal(ref.category_id, orig.category_id);
    assert.equal(ref.note, '');
    assert.equal(orig.amount_cents, S.cents);
    assert.equal(orig.flag_amount_review, false);
  });

  test(`${S.name}：促销邮件 → 忽略，只记凭据（ignored_not_receipt），不入账`, () => {
    const t = setup();
    const m = S.promo();
    assert.equal(t.handle(m).outcome, 'ignored_not_receipt');
    assert.equal(t.entries().length, 0);
    assert.equal(t.source('gmail:msg:' + m.id).outcome, 'ignored_not_receipt');
  });

  test(`${S.name}：同一订单改小费后金额不同 → 不新增，原账目标“待核对金额”；金额相同 → 不改动`, () => {
    const t = setup();
    t.handle(S.receipt());
    const r = t.handle(S.revised());
    assert.equal(r.outcome, 'revision_flagged');
    assert.equal(t.entries().length, 1);
    assert.equal(t.entries()[0].flag_amount_review, true);
    assert.equal(t.g.entryStatus(t.entries()[0]), 'amount_review');

    const t2 = setup();
    t2.handle(S.receipt());
    const same = Object.assign({}, S.receipt(), { id: pid.slice(0, 2) + '00000000s1' });
    assert.equal(t2.handle(same).outcome, 'duplicate_noop');
    assert.equal(t2.entries().length, 1);
    assert.equal(t2.entries()[0].flag_amount_review, false);
  });

}

test('D7：DoorDash 缺订单号时仅同一家餐厅 6 小时内标重复，并只保存餐厅哈希', () => {
  const t = setup();
  const first = F.ddReceiptNoRef({ id: 'dd00000000d1', at: '2026-10-15T10:00:00.000Z' });
  first.subject = 'Your order from Noodle House';
  const second = F.ddReceiptNoRef({ id: 'dd00000000d2', at: '2026-10-15T15:59:00.000Z' });
  second.subject = 'Your order from Noodle House';
  t.handle(first);
  t.handle(second);
  const [a, b] = t.entries();
  assert.ok(a.flag_dup && b.flag_dup);
  assert.equal(a.dup_group, b.dup_group);
  assert.ok(a.restaurant_key);
  assert.equal(a.restaurant_key, b.restaurant_key);
  assert.equal(JSON.stringify([a, b]).includes('Noodle House'), false);
});

test('D7：不同餐厅、超过 6 小时、或无法读到餐厅名时不标重复', () => {
  const cases = [
    ['different restaurant', 'Your order from Noodle House', 'Your order from Taco Planet', 2],
    ['outside window', 'Your order from Noodle House', 'Your order from Noodle House', 7],
    ['missing restaurant', 'Your DoorDash receipt', 'Your DoorDash receipt', 1]
  ];
  cases.forEach(([label, firstSubject, secondSubject, hours], i) => {
    const t = setup();
    const first = F.ddReceiptNoRef({ id: 'dd00000000' + String(i + 3) + 'a', at: '2026-10-15T10:00:00.000Z' });
    const second = F.ddReceiptNoRef({ id: 'dd00000000' + String(i + 3) + 'b', at: new Date(Date.parse('2026-10-15T10:00:00.000Z') + hours * H).toISOString() });
    first.subject = firstSubject;
    second.subject = secondSubject;
    t.handle(first);
    t.handle(second);
    const pair = t.entries().slice(-2);
    assert.ok(pair.every((e) => !e.flag_dup), label);
  });
});

// ---------------- Uber Eats 专项 ----------------

test('Uber 打车收据（含页脚 Uber Eats 广告）→ 入账为交通；Uber Eats 收据 → 入账为餐饮', () => {
  const t = setup();
  t.handle(F.uberRide());
  t.handle(F.uberRide({ id: 'ur00000000f1', footer: true }));
  t.handle(F.uberOne());
  t.handle(F.uberCash());
  assert.equal(t.entries().length, 2);
  assert.ok(t.entries().every((e) => e.merchant === 'Uber' && e.category_id === t.transport()));
  assert.equal(t.pending().length, 0, '打车收据不列入待查看');
  t.handle(F.ueReceipt());
  assert.equal(t.entries().length, 3);
  assert.equal(t.entries()[2].category_id, t.dining());
});

test('G1：Uber 发件域名的普通收据主题按打车处理，读到金额则记入交通', () => {
  const t = setup();
  const m = F.uberUnknownWithAmount();
  const r = t.handle(m);
  assert.equal(r.outcome, 'created');
  assert.equal(t.entries().length, 1);
  assert.equal(t.entries()[0].merchant, 'Uber');
  assert.equal(t.entries()[0].category_id, t.transport());
});


// ---------------- 共用流程 ----------------

test('共用：多个不同的总额 → 待查看；同一封邮件处理两次只保留一条待查看', () => {
  const t = setup();
  const m = F.mail({ id: 'dd00000000m1', from: 'DoorDash <no-reply@doordash.com>', subject: 'Your receipt',
    html: F.receiptHtml({ title: 'x', rows: [['Total', '$23.45'], ['Order Total', '$25.00']] }) });
  t.handle(m);
  assert.equal(t.entries().length, 0);
  assert.equal(t.pending()[0].amount_cents, null);
  assert.equal(t.pending()[0].reason, 'MULTIPLE_TOTALS');
  assert.equal(t.handle(m).outcome, 'skipped');
  assert.equal(t.pending().length, 1);
});

test('共用：删除后再处理同一封邮件 → 不会重新出现；恢复后回到原月份', () => {
  const t = setup();
  const m = F.ddReceipt();
  t.handle(m);
  const id = t.entries()[0].id;
  t.g.svcDeleteEntry(t.repo, id, t.now());
  t.handle(m);
  // 30 天后被彻底清除，凭据还在：仍不会出现
  t.g.svcPurgeDeleted(t.repo, new Date(t.now().getTime() + 31 * 24 * H));
  assert.equal(t.entries().length, 0);
  t.handle(m);
  t.handle(Object.assign({}, m, { id: 'dd00000000z9' }));   // 同一订单的另一封收据：原账目已清除 → 只记凭据
  assert.equal(t.entries().length, 0);
  assert.equal(t.source('gmail:msg:dd00000000z9').outcome, 'duplicate_noop');

  const t2 = setup();
  t2.handle(m);
  const e = t2.entries()[0];
  t2.g.svcDeleteEntry(t2.repo, e.id, t2.now());
  t2.g.svcRestoreEntry(t2.repo, e.id, t2.now());
  assert.equal(t2.live()[0].month_ny, e.month_ny);
});

test('共用：退款找不到原订单 → 仍新增负支出，类别餐饮，备注“未能自动关联原订单”', () => {
  const t = setup();
  t.handle(F.ddRefund({ orderId: null }));
  const e = t.entries()[0];
  assert.equal(e.amount_cents, -500);
  assert.equal(e.refund_of, null);
  assert.equal(e.category_id, t.dining());
  assert.equal(e.note, '未能自动关联原订单');
  // 订单号有、但没记过这个订单 → 同样未关联
  t.handle(F.ddRefund({ id: 'dd00000000u2', orderId: 'zzzz-9999' }));
  assert.equal(t.entries()[1].refund_of, null);
});

test('共用：退款金额读不出 → 退款为待补全（金额为空），is_refund 仍为是', () => {
  const t = setup();
  t.handle(F.ddReceipt());
  t.handle(F.ddRefund({ amount: 'see app' }));
  const ref = t.entries()[1];
  assert.equal(ref.amount_cents, null);
  assert.equal(ref.is_refund, true);
  assert.equal(t.g.entryStatus(ref), 'pending');
});

test('共用：原账目已删除 → 退款照常新增并关联原订单；修订邮件只记凭据，不标记也不新建', () => {
  const t = setup();
  t.handle(F.ddReceipt());
  const orig = t.entries()[0];
  t.g.svcDeleteEntry(t.repo, orig.id, t.now());
  assert.equal(t.handle(F.ddReceipt({ id: 'dd00000000r2', total: '$30.00' })).outcome, 'duplicate_noop');
  assert.equal(t.entries().length, 1);
  assert.equal(t.entries()[0].flag_amount_review, false);
  assert.equal(t.handle(F.ddRefund()).outcome, 'refund_created');
  const ref = t.entries()[1];
  assert.equal(ref.refund_of, orig.id);
  assert.equal(ref.amount_cents, -500);
  assert.equal(t.g.svcGetEntry(t.repo, ref.id).refund_of_label.includes('原交易已删除'), true);
});

test('共用：同一订单、同金额、1 天内的两封不同退款邮件 → 两笔退款都标待核对重复', () => {
  const t = setup();
  t.handle(F.ddReceipt());
  t.handle(F.ddRefund({ id: 'dd00000000f1', at: '2026-10-15T16:00:00.000Z' }));
  t.handle(F.ddRefund({ id: 'dd00000000f2', at: '2026-10-15T20:00:00.000Z' }));
  const refunds = t.entries().filter((e) => e.is_refund);
  assert.equal(refunds.length, 2);
  assert.ok(refunds.every((e) => e.flag_dup));
  assert.equal(refunds[0].dup_group, refunds[1].dup_group);
  assert.equal(t.entries().find((e) => !e.is_refund).flag_dup, false);
});

test('D7：同餐厅 6 小时内金额相同或不同都标待核对；6 小时外和跨平台不标', () => {
  for (const total of ['$23.45', '$40.00']) {
    const t = setup();
    const a = F.ddReceiptNoRef({ id: 'dd00000000d1', at: '2026-10-15T10:00:00.000Z' });
    const b = F.ddReceiptNoRef({ id: 'dd00000000d2', total, at: '2026-10-15T15:00:00.000Z' });
    a.subject = b.subject = 'Your order from Noodle House';
    t.handle(a); t.handle(b);
    const es = t.entries();
    assert.equal(es.length, 2, total);
    assert.ok(es.every((e) => e.flag_dup && e.dup_group === es[0].dup_group), total);
    // “两笔都保留”之后不再标记（沿用 Apple Pay 切片的 api_keepDuplicates）
    t.g.svcKeepDuplicates(t.repo, es[1].id, t.now());
    assert.ok(t.entries().every((e) => !e.flag_dup));
  }
  const far = setup();
  const oldOne = F.ddReceiptNoRef({ id: 'dd00000000d3', at: '2026-10-15T10:00:00.000Z' });
  const newOne = F.ddReceiptNoRef({ id: 'dd00000000d4', total: '$40.00', at: '2026-10-15T16:00:01.000Z' });
  oldOne.subject = newOne.subject = 'Your order from Noodle House';
  far.handle(oldOne); far.handle(newOne);
  assert.ok(far.entries().every((e) => !e.flag_dup), '超过 6 小时');
  const other = setup();
  other.handle(F.ueReceipt({ at: '2026-10-15T10:00:00.000Z' }));
  other.handle(F.ddReceiptNoRef({ id: 'dd00000000d5', total: '$40.00', at: '2026-10-15T16:00:00.000Z' }));
  assert.ok(other.entries().every((e) => !e.flag_dup), '不同平台之间不适用 D7');
});

test('两个平台出现相同的订单号时互不干扰（键中含平台名）', () => {
  const t = setup();
  const first = F.ddReceipt({ orderId: 'SAME-12345' });
  const second = F.ddReceipt({ id: 'dd00000000h1', orderId: 'SAME-12345', total: '$40.00' });
  t.handle(first);
  t.handle(second);   // 同一平台：修订（金额不同 → 待核对金额）
  const dd = F.ddReceipt({ id: 'dd00000000o1', orderId: 'SAME-12345' });
  assert.equal(t.handle(dd).outcome, 'duplicate_noop');
  assert.ok(t.source('order:doordash:SAME-12345:receipt'));
  assert.equal(t.entries().length, 1);
});

test('关闭（enabled = false）的平台：邮件被忽略并记录 ignored_platform_disabled；不参与合并搜索', () => {
  const t = setup();
  const platforms = t.platforms.map((p) => (p.id === 'doordash' ? Object.assign({}, p, { enabled: false }) : p));
  const m = F.ddReceipt();
  assert.equal(t.handle(m, platforms).outcome, 'ignored_platform_disabled');
  assert.equal(t.entries().length, 0);
  assert.equal(t.source('gmail:msg:' + m.id).outcome, 'ignored_platform_disabled');
  const unsupported = t.platforms.map((p) => (p.id === 'ubereats' ? Object.assign({}, p, { support_status: 'unsupported' }) : p));
  assert.equal(t.handle(F.ueReceipt(), unsupported).outcome, 'ignored_platform_disabled');
  const partial = t.platforms.map((p) => (p.id === 'uber' ? Object.assign({}, p, { support_status: 'partial' }) : p));
  t.handle(F.uberRide(), partial);
  assert.equal(t.entries().length, 0);
  assert.equal(t.pending()[0].reason, 'PARTIAL_SUPPORT', '部分支持的新收据进入待查看');
});

// ---------------- D16 ----------------

test('D16：PLATFORM_AMBIGUOUS 邮件不入账，列入待查看；重复处理不会重复列出；“已查看”后移除且不再出现', () => {
  const t = setup();
  const clone = Object.assign({}, t.g.RECEIPT_PLATFORM_DOORDASH, { id: 'dd2', displayName: 'DD2' });
  const platforms = t.platforms.concat([clone]);
  const m = F.ddReceipt({ at: '2026-10-14T12:00:00.000Z' });
  const r = t.handle(m, platforms);
  assert.equal(r.outcome, 'uncertain');
  assert.equal(r.code, 'PLATFORM_AMBIGUOUS');
  assert.equal(t.entries().length, 0);
  assert.equal(t.pending().length, 1);
  assert.equal(t.pending()[0].platforms, 'doordash,dd2');
  // 重复处理：凭据已在 → 跳过；即使凭据丢了（中途中断），列表里也只有一行
  t.handle(m, platforms);
  t.repo.removeByKeys('processed_sources', ['gmail:msg:' + m.id]);
  t.handle(m, platforms);
  assert.equal(t.repo.list('gmail_pending').length, 1);
  const st = t.g.svcGmailStatus(t.repo, t.now(), t.now().toISOString(), platforms);
  assert.equal(st.pending.length, 1);
  assert.equal(st.pending[0].platforms, 'DoorDash／DD2');
  assert.equal(st.pending[0].link, 'https://mail.google.com/mail/u/0/#all/' + m.id);
  assert.equal(st.pending[0].date_local, '2026-10-14T08:00');
  t.g.svcMarkMailReviewed(t.repo, m.id, t.now());
  assert.equal(t.pending().length, 0);
  t.repo.removeByKeys('processed_sources', ['gmail:msg:' + m.id]);
  t.handle(m, platforms);
  assert.equal(t.pending().length, 0, '已查看过的邮件不再列出');
  assert.throws(() => t.g.svcMarkMailReviewed(t.repo, 'nope-not-here', t.now()), /找不到这封邮件/);
  assert.throws(() => t.g.svcMarkMailReviewed(t.repo, '<script>', t.now()), /邮件编号不正确/);
});

test('D16：待查看邮件计入小助手 pending_items（只有邮件时也会提醒），已查看后归零', () => {
  const t = setup();
  t.handle(F.genericReceipt());
  t.g.svcRunAssistantRules(t.repo, t.now(), t.newId);
  const msgs = t.repo.list('assistant_messages').filter((m) => m.skill_id === 'pending_items');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /1 封待查看邮件/);
  assert.match(msgs[0].text, /名单外的邮件不会自动记账/);
  assert.equal(msgs[0].action, 'goto:mail_pending');
  const answer = t.g.svcAskAssistant(t.repo, 'q_pending', t.now());
  assert.match(answer.text, /1 封待查看邮件/);
  assert.match(answer.text, /以后自动记/);
  assert.equal(answer.action, 'goto:mail_pending');
  t.g.svcMarkMailReviewed(t.repo, 'un0000000001', t.now());
  assert.equal(t.g.buildSnapshot(t.g.assistantData_(t.repo, t.now()), t.now()).attention.mail, 0);
});

test('名单商家：只有收据主题且唯一总额才自动入账；否则进入待查看并可重试而不重复', () => {
  const t = setup();
  t.repo.insert('mail_senders', { domain: 'shop.example', display_name: 'Example Shop', category_id: t.dining(), mode: 'auto', created_at: t.now().toISOString() });
  const valid = F.genericReceipt({ domain: 'shop.example', id: 'au0000000001' });
  const r = t.handle(valid);
  assert.equal(r.outcome, 'created');
  assert.deepEqual([t.entries()[0].merchant, t.entries()[0].category_id, t.entries()[0].channel,
    t.entries()[0].platform, t.entries()[0].source_key], ['Example Shop', t.dining(), 'gmail_receipt', 'mail:shop.example', 'gmail:msg:au0000000001']);
  assert.equal(t.handle(valid).outcome, 'skipped');
  const noReceiptSubject = F.genericReceipt({ domain: 'shop.example', id: 'au0000000002', subject: 'Monthly update' });
  assert.equal(t.handle(noReceiptSubject).pending_added, 1);
  const multiple = F.genericReceipt({ domain: 'shop.example', id: 'au0000000003', total: '$8.00' });
  multiple.text = 'Total: $7.25\nGrand Total: $8.00'; multiple.html = '';
  assert.equal(t.handle(multiple).pending_added, 1);
  assert.equal(t.repo.list('gmail_pending').length, 2);
  assert.ok(t.repo.list('gmail_pending').every((m) => m.reason === 'AUTO_SENDER_NEEDS_REVIEW'));
});

test('名单外邮件只进待查看；domain+金额保存，不保存邮件原文；已看过后不重复', () => {
  const t = setup();
  const mail = F.genericReceipt({ id: 'un0000000002', domain: 'tiny.example' });
  assert.equal(t.handle(mail).pending_added, 1);
  assert.equal(t.handle(mail).outcome, 'skipped');
  const row = t.repo.list('gmail_pending')[0];
  assert.deepEqual([row.sender_domain, row.amount_cents, row.reason], ['tiny.example', 725, 'UNLISTED']);
  const dump = JSON.stringify(t.repo.tables);
  for (const secret of [F.SUBJECT_MARKER, F.BODY_MARKER, F.FAKE_ADDRESS, 'receipts@tiny.example', 'Your receipt']) assert.equal(dump.includes(secret), false);
});

// ---------------- 第四个平台 ----------------

test('注册一个虚构的第四个平台（只写规则文件 + 样本），共用流程不改就能入账、退款、D2 下单时间', () => {
  const t = setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'fixtures', 'fictitious-platform.js'), 'utf8'), t.g);
  const platforms = t.platforms.concat([t.g.RECEIPT_PLATFORM_PIZZAPLANET]);
  assert.match(t.g.buildReceiptQuery(platforms), /from:\(pizzaplanet\.example\)/);
  const from = 'Pizza Planet <hello@pizzaplanet.example>';
  const html = F.receiptHtml({ title: 'Ordered at: 2026-01-31T23:58Z', rows: [['Pizza Subtotal', '$10.00'], ['Amount Paid', '$12.34'], ['Pizza order', 'PP-7788']] });
  const m = F.mail({ id: 'pp0000000001', from, subject: 'Your pizza receipt', html, at: '2026-02-01T05:30:00.000Z' });
  assert.equal(t.handle(m, platforms).outcome, 'created');
  const e = t.entries()[0];
  assert.deepEqual([e.amount_cents, e.merchant, e.platform, e.order_ref], [1234, 'Pizza Planet', 'pizzaplanet', 'PP-7788']);
  assert.equal(e.occurred_at, '2026-01-31T23:58:00.000Z', '可靠的下单时间（D2）');
  assert.equal(e.month_ny, '2026-01');
  const refund = F.mail({ id: 'pp0000000002', from, subject: 'Money back for your pizza',
    html: F.receiptHtml({ title: 'x', rows: [['Pizza order', 'PP-7788'], ['Money Back', '$2.00']] }), at: '2026-02-02T05:30:00.000Z' });
  t.handle(refund, platforms);
  assert.equal(t.entries()[1].refund_of, e.id);
  // 下单时间与到达时间相差太多（早于 3 天）→ 不用
  const odd = F.mail({ id: 'pp0000000003', from, subject: 'Your pizza receipt', at: '2026-03-01T05:30:00.000Z',
    html: F.receiptHtml({ title: 'Ordered at: 2026-01-01T10:00Z', rows: [['Amount Paid', '$9.00'], ['Pizza order', 'PP-9900']] }) });
  t.handle(odd, platforms);
  assert.equal(t.entries()[2].occurred_at, '2026-03-01T05:30:00.000Z');
});

// ---------------- 跨渠道疑似重复 ----------------

test('跨渠道：Apple Pay Uber 与 Uber 打车收据同金额、24 小时内 → 两笔都标待核对重复', () => {
  const t = setup();
  t.handle(F.uberRide({ at: '2026-10-15T15:00:00.000Z' }));
  t.applePay('UBER TRIP', '$18.75');
  const es = t.entries();
  assert.equal(es.length, 2);
  assert.ok(es.every((e) => e.flag_dup));
  assert.equal(es[0].dup_group, es[1].dup_group);
});

test('跨渠道：Apple Pay 先到、Uber Eats 收据后到 → 两笔都标；DoorDash 同理；金额不同不标', () => {
  const t = setup();
  t.applePay('UBER *EATS', '$31.20', '2026-10-15T15:00:00.000Z');
  t.handle(F.ueReceipt());
  assert.ok(t.entries().every((e) => e.flag_dup));

  const t2 = setup();
  t2.applePay('DOORDASH*ZEBRACORN', '$23.45');
  t2.handle(F.ddReceipt());
  assert.ok(t2.entries().every((e) => e.flag_dup));

  const t3 = setup();
  t3.applePay('DOORDASH*ZEBRACORN', '$20.00');
  t3.handle(F.ddReceipt());
  assert.ok(t3.entries().every((e) => !e.flag_dup), '金额不同（例如小费后来调整）不标（风险 R17）');

  const t4 = setup();
  t4.applePay('PANDA EXPRESS', '$18.75');
  t4.handle(F.uberRide());
  assert.ok(t4.entries().every((e) => !e.flag_dup), '商家不相近');
});

test('跨渠道：手动记一笔 Uber 打车与收据同金额 → 两笔都标', () => {
  const t = setup();
  t.handle(F.uberRide({ at: '2026-10-15T15:00:00.000Z' }));
  t.g.svcSaveEntry(t.repo, { type: 'expense', amount: '18.75', category_id: t.transport(), local_datetime: '2026-10-15T12:00', merchant: 'Uber' },
    t.now(), t.newId);
  assert.ok(t.entries().every((e) => e.flag_dup));
});

// ---------------- 中断与隐私 ----------------

test('中断恢复：账目已写、凭据没写 → 再处理只补写凭据，不会多记', () => {
  const t = setup();
  const m = F.ddReceipt();
  t.handle(m);
  t.repo.removeByKeys('processed_sources', ['gmail:msg:' + m.id, 'order:doordash:a1b2c3d4-0001:receipt']);
  assert.equal(t.handle(m).outcome, 'repaired');
  assert.equal(t.entries().length, 1);
  assert.ok(t.source('order:doordash:a1b2c3d4-0001:receipt'));
});

test('隐私：待查看只保存发件网域和金额，不保存主题、正文、地址或发件人完整地址', () => {
  const t = setup();
  const generic = { id: 'un0000000001', from: 'Shop <receipts@shop.example>', subject: 'Your receipt ' + F.SUBJECT_MARKER,
    text: F.BODY_MARKER + '\nTotal: $7.25', at: '2026-10-15T16:00:00.000Z' };
  const all = [F.ddReceipt(), F.ddRefund(), F.ddPromo(), F.ueReceipt(), F.uberRide({ footer: true }), generic];
  t.poll(memoryClient(t.g, all));
  const dump = JSON.stringify(t.repo.tables);
  assert.ok(t.repo.list('gmail_pending').some((r) => r.sender_domain === 'shop.example' && r.amount_cents === 725));
  for (const bad of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'no-reply@doordash.com', 'uber@uber.com', 'receipts@shop.example',
    'Spicy Noodles', 'Order Confirmation', 'Your receipt']) {
    assert.equal(dump.includes(bad), false, '账本里不应出现：' + bad);
  }
});

// ---------------- 轮询 ----------------

test('轮询：一次合并搜索，翻页直到读完（51 封以上不漏），只读取没处理过的邮件', () => {
  const t = setup();
  const msgs = [];
  for (let i = 0; i < 55; i++) msgs.push(F.ddPromo({ id: 'pg' + String(i).padStart(10, '0') }));
  msgs.push(F.ddReceipt({ id: 'pgreceipt001' }));
  const c = memoryClient(t.g, msgs, { pageSize: 50 });
  const r = t.poll(c);
  assert.equal(r.pages, 2);
  assert.equal(r.listed, 56);
  assert.equal(r.read, 30, '每轮最多读取 30 封');
  assert.equal(r.created, 0, '本批 30 封均为促销');
  assert.equal(c.calls.list.length, 2);
  assert.equal(c.calls.list[0].q, t.g.buildReceiptQuery(t.platforms));
  assert.equal(c.calls.list[1].token, '50');
  assert.equal(r.volume_high, true);
  assert.equal(r.error_code, 'READ_VOLUME_HIGH', '达到上限后提示下一轮继续');
  const again = memoryClient(t.g, msgs, { pageSize: 50 });
  const r2 = t.poll(again);
  assert.equal(r2.read, 26, '下一轮继续读取未处理邮件');
  assert.equal(again.calls.get.length, 26);
});

test('轮询：按平台记录状态（最后入账、到达 → 入账耗时、最近问题），总状态记录运行时间', () => {
  const t = setup('2026-10-15T16:10:00.000Z');
  t.poll(memoryClient(t.g, [F.ddReceipt({ at: '2026-10-15T16:00:00.000Z' }), F.uberRide({ id: 'ur0000000011' })]));
  const row = (ch) => t.repo.list('channel_status').find((r) => r.channel === ch);
  assert.equal(row('gmail').last_run_at, '2026-10-15T16:10:00.000Z');
  assert.equal(row('gmail').last_success_at, '2026-10-15T16:10:00.000Z');
  assert.equal(row('gmail:doordash').last_entry_at, '2026-10-15T16:10:00.000Z');
  assert.equal(row('gmail:doordash').last_latency_sec, 600);
  assert.equal(row('gmail:uber').last_entry_at, '2026-10-15T16:10:00.000Z');
  assert.ok(!row('gmail:ubereats').last_entry_at);
  const st = plain(t.g.svcGmailStatus(t.repo, t.now(), '2026-10-15T16:00:00.000Z'));
  assert.deepEqual(st.warnings, []);
  const dd = st.platforms.find((p) => p.id === 'doordash');
  assert.equal(dd.last_latency_min, 10);
  assert.equal(dd.support_label, '未验证');
  assert.equal(st.platforms.find((p) => p.id === 'uber').last_entry_local, '2026-10-15T12:10');
});

test('轮询：列表出错 → 记录 AUTH_REVOKED / QUOTA_EXCEEDED，不抛错；读取时额度用完 → 停止本轮，没读的下次再读', () => {
  const t = setup();
  const c = memoryClient(t.g, [F.ddReceipt()]);
  c.fail.list = new Error('Request had insufficient authentication scopes. (403)');
  assert.equal(t.poll(c).error_code, 'AUTH_REVOKED');
  c.fail.list = new Error('User-rate limit exceeded');
  assert.equal(t.poll(c).error_code, 'QUOTA_EXCEEDED');
  const st = t.g.svcGmailStatus(t.repo, t.now(), t.now().toISOString());
  assert.match(st.warnings.join(), /读取额度/);
  c.fail.list = null;
  c.fail.get = new Error('Quota exceeded for quota metric');
  const r = t.poll(c);
  assert.equal(r.error_code, 'QUOTA_EXCEEDED');
  assert.equal(t.entries().length, 0);
  c.fail.get = null;
  t.setNow('2026-10-15T16:15:00.000Z');
  assert.equal(t.poll(c).created, 1, '下一轮照常入账');
  assert.equal(t.g.svcGmailStatus(t.repo, t.now(), t.now().toISOString()).warnings.length, 0, '成功后红色提示消失');
});

test('轮询：某一封读取失败（非额度/授权问题）→ 跳过它继续处理其他邮件，记 MESSAGE_FAILED', () => {
  const t = setup();
  const c = memoryClient(t.g, [F.ddReceipt(), F.ueReceipt()]);
  c.fail.get = (id) => (id === 'dd0000000001' ? new Error('Backend Error') : null);
  const r = t.poll(c);
  assert.equal(r.created, 1);
  assert.equal(r.errors, 1);
  assert.equal(r.error_code, 'MESSAGE_FAILED');
});

test('轮询：还没重新运行 setupLedger（没有 gmail_pending 表）→ SETUP_REQUIRED，不读取 Gmail', () => {
  const t = setup(undefined, { without: ['gmail_pending'] });
  const c = memoryClient(t.g, [F.ddReceipt()]);
  assert.equal(t.poll(c).error_code, 'SETUP_REQUIRED');
  assert.equal(c.calls.list.length, 0);
  assert.equal(t.g.svcPendingMailCount_(t.repo), 0);
});

// ---------------- 状态与心跳 ----------------

test('状态：未开启 → 不报错、没有警告；开启后超过 20 分钟没运行 → “可能已停止”', () => {
  const t = setup('2026-10-15T16:00:00.000Z');
  const off = plain(t.g.svcGmailStatus(t.repo, t.now(), null));
  assert.equal(off.enabled, false);
  assert.deepEqual(off.warnings, []);
  assert.deepEqual(off.platforms, []);
  const fresh = plain(t.g.svcGmailStatus(t.repo, t.now(), '2026-10-15T15:50:00.000Z'));
  assert.equal(fresh.stale, false, '刚开启 10 分钟，还没运行过也不报警');
  const stale = plain(t.g.svcGmailStatus(t.repo, t.now(), '2026-10-15T15:30:00.000Z'));
  assert.equal(stale.stale, true);
  assert.match(stale.warnings.join(), /可能已停止/);
  t.poll(memoryClient(t.g, []));
  t.setNow('2026-10-15T16:19:00.000Z');
  assert.equal(t.g.svcGmailStatus(t.repo, t.now(), '2026-10-15T15:30:00.000Z').stale, false);
  t.setNow('2026-10-15T16:21:00.000Z');
  assert.equal(t.g.svcGmailStatus(t.repo, t.now(), '2026-10-15T15:30:00.000Z').stale, true);
});

test('打开网页（svcBootstrap）带上外卖收据状态；状态读取出错也不影响打开网页', () => {
  const t = setup();
  const boot = t.g.svcBootstrap(t.repo, t.now(), false, null);
  assert.equal(boot.gmail.enabled, false);
  const broken = Object.assign({}, t.repo, { list: (tb) => { if (tb === 'gmail_pending') throw new Error('boom'); return t.repo.list(tb); } });
  const boot2 = t.g.svcBootstrap(broken, t.now(), false, t.now().toISOString());
  assert.equal(boot2.gmail.unavailable, true);
  assert.equal(boot2.gmail.enabled, true);
});

// ---------------- G1 试运行 ----------------

test('G1 试运行：每行只有编号后 6 位、到达时间、发件域名、分类、金额、订单号有无、标签；不含主题和正文；不写账本', () => {
  const t = setup();
  const before = JSON.stringify(t.repo.tables);
  const msgs = [F.ddReceipt(), F.ddRefund(), F.ddPromo(), F.ddReceiptNoRef({ id: 'dd00000000n7' })];
  const lines = [];
  const r = plain(t.g.svcDryRunReceipts(memoryClient(t.g, msgs), 'doordash', t.platforms, (l) => lines.push(l)));
  assert.deepEqual(r, { platform: 'doordash', count: 4 });
  assert.equal(lines.length, 5);
  assert.equal(lines[1], '…000001 | 2026-10-15 12:00 | doordash.com | receipt | 23.45 USD | 订单号:有 | 总额标签:Total');
  assert.equal(lines[3], '…000003 | 2026-10-15 12:00 | doordash.com | other | - | 订单号:- | 总额标签:未找到');
  const all = lines.join('\n');
  for (const bad of [F.BODY_MARKER, F.SUBJECT_MARKER, F.FAKE_ADDRESS, 'Order Confirmation', 'no-reply', 'dd0000000001', 'a1b2c3d4']) {
    assert.equal(all.includes(bad), false, '日志里不应出现：' + bad);
  }
  assert.equal(JSON.stringify(t.repo.tables), before, '不写账本');
  assert.throws(() => t.g.svcDryRunReceipts(memoryClient(t.g, []), 'grubhub', t.platforms, () => {}), /doordash、uber、ubereats/);
});

// ---------------- 评审修复 ----------------

for (const [pid, sample] of [['doordash', () => F.ddReceipt({ id: 'dd00000000k1' })], ['ubereats', () => F.ueReceipt({ id: 'ue00000000k1' })]]) {
  test(`${pid}：收据主题同时带促销字样 → 不入账，列入待查看邮件（不会永久丢失）`, () => {
    const t = setup();
    const m = Object.assign({}, sample(), {
      subject: { doordash: 'Order Confirmation for Big Deal Burgers', ubereats: 'Your Uber Eats order with Hot Deals Pizza' }[pid]
    });
    assert.equal(t.handle(m).outcome, 'uncertain');
    assert.equal(t.entries().length, 0);
    assert.equal(t.pending().length, 1);
    assert.equal(t.pending()[0].platforms, pid);
  });
}

test('同一订单的第二封收据读不出金额 → 不新增，原账目标“待核对金额”（revision_flagged）', () => {
  const t = setup();
  t.handle(F.ddReceipt());
  const r = t.handle(F.ddReceipt({ id: 'dd00000000q1', total: 'see app' }));
  assert.equal(r.outcome, 'revision_flagged');
  assert.equal(t.entries().length, 1);
  assert.equal(t.entries()[0].flag_amount_review, true);
  assert.equal(t.source('gmail:msg:dd00000000q1').outcome, 'revision_flagged');
});

test('轮询：翻页达到上限还有下一页 → 记录 TOO_MANY_PAGES（不悄悄停下），已列出的照常处理', () => {
  const t = setup();
  const msgs = [];
  for (let i = 0; i < 25; i++) msgs.push(F.ddPromo({ id: 'tp' + String(i).padStart(10, '0') }));
  const r = t.poll(memoryClient(t.g, msgs, { pageSize: 1 }));
  assert.equal(r.pages, t.g.GMAIL_MAX_PAGES);
  assert.equal(r.too_many_pages, true);
  assert.equal(r.read, 20);
  assert.equal(r.error_code, 'TOO_MANY_PAGES');
  const row = t.repo.list('channel_status').find((x) => x.channel === 'gmail');
  assert.equal(row.last_error_code, 'TOO_MANY_PAGES');
  assert.match(row.last_error_text, /翻页上限/);
});

test('轮询：连续读取失败也按每次 Messages.get 尝试计算 30 封上限', () => {
  const t = setup();
  const msgs = Array.from({ length: 35 }, (_, i) => F.ddPromo({ id: 'fail' + String(i).padStart(9, '0') }));
  const c = memoryClient(t.g, msgs, { pageSize: 50 });
  c.fail.get = new Error('Backend Error');
  const r = t.poll(c);
  assert.equal(c.calls.get.length, 30, '失败的 get 尝试也占读取额度');
  assert.equal(r.read, 30);
  assert.equal(r.errors, 30);
  assert.equal(r.volume_high, true);
  assert.equal(r.error_code, 'MESSAGE_FAILED', '具体读取错误优先于剩余量提示');
});

test('轮询：超过约 4 分钟就停止本轮，没处理的邮件下一轮接着处理', () => {
  const t = setup();
  const msgs = [F.ddReceipt(), F.ueReceipt(), F.uberRide()];
  let ms = 0;
  const clock = () => ms;
  const c = memoryClient(t.g, msgs);
  const realGet = c.get;
  c.get = (id) => { ms += 3 * 60000; return realGet(id); };   // 每封“用了” 3 分钟
  const r = plain(t.g.svcPollReceipts(t.repo, c, t.now(), t.platforms, t.newId, clock));
  assert.equal(r.time_limited, true);
  assert.equal(r.created, 2, '第 1 封 3 分钟、第 2 封到 6 分钟，第 3 封前停止');
  const r2 = t.poll(memoryClient(t.g, msgs));
  assert.equal(r2.created, 1, '下一轮接着处理剩下的');
  assert.equal(t.entries().length, 3);
});

test('试运行日志：判为 uncertain 时写出原因代码（命中的规则词），不写主题和正文；正常收据没有原因代码', () => {
  const t = setup();
  const ok = t.g.dryRunLine(F.ddReceipt({ id: 'dd00000000w1' }), t.platforms);
  assert.match(ok, /\| receipt \| 23\.45 USD \|/);
  assert.doesNotMatch(ok, /\(/, '正常收据没有原因代码');

  const base = F.ddReceipt({ id: 'dd00000000w2' });
  const unpaid = Object.assign({}, base, { html: base.html.replace('</body>', '<p>Amount due: $23.45</p></body>') });
  const line = t.g.dryRunLine(unpaid, t.platforms);
  assert.match(line, /\| uncertain\(UNPAID_WORD:amount due\) \| 23\.45 USD \|/);
  for (const secret of [F.SUBJECT_MARKER, F.BODY_MARKER, F.FAKE_ADDRESS, 'Noodle']) assert.ok(!line.includes(secret), '日志不含 ' + secret);

  // 标题不是订单确认：预估总额仍是 uncertain
  const estimate = Object.assign({}, base, { subject: 'Your DoorDash receipt', html: base.html.replace('</body>', '<p>Estimated total $23.45</p></body>') });
  assert.match(t.g.dryRunLine(estimate, t.platforms), /uncertain\(ESTIMATE_WORD:estimated total\)/);
  // 订单确认 + 预估总额：记账并标待核对金额
  const confirm = Object.assign({}, base, { html: base.html.replace('</body>', '<p>Estimated total $23.45</p></body>') });
  assert.match(t.g.dryRunLine(confirm, t.platforms), /\| receipt\(ESTIMATED_TOTAL_REVIEW\) \| 23\.45 USD \|/);
});

/** DoorDash 订单确认邮件，正文写的是预估总额（合成样本） */
function ddEstimated(extra = '', opts = {}) {
  const m = F.ddReceipt(Object.assign({ id: 'dd0000000e01', total: '$20.47' }, opts));
  return Object.assign({}, m, opts.subject ? { subject: opts.subject } : {},
    { html: m.html.replace('</body>', '<p>Estimated total. Final charge may change if you adjust the tip.</p>' + extra + '</body>') });
}

test('DoorDash 订单确认写着 estimated total：照常记账，金额照读，账目标“待核对金额”，不进待查看；重复处理不再新增', () => {
  const t = setup();
  const m = ddEstimated();
  const r = t.handle(m);
  assert.equal(r.outcome, 'created');
  const e = t.live()[0];
  assert.equal(e.amount_cents, 2047);
  assert.equal(e.flag_amount_review, true);
  assert.equal(e.category_id, t.dining());
  assert.equal(t.g.entryStatus(e), 'amount_review');
  assert.deepEqual(t.pending(), []);
  assert.equal(t.handle(m).outcome, 'skipped', '同一封邮件已处理过');
  assert.equal(t.live().length, 1);
});

test('DoorDash 预估总额的放宽只限订单确认：还有未付款说法、标题像广告、标题不是订单确认时仍进待查看；Uber 不受影响；普通收据不标待核对', () => {
  const t = setup();
  // 同时写着 amount due：仍不确定
  assert.equal(t.handle(ddEstimated('<p>Amount due: $20.47</p>', { id: 'dd0000000e02' })).outcome, 'uncertain');
  // 标题像促销
  assert.equal(t.handle(ddEstimated('', { id: 'dd0000000e03', subject: 'Order Confirmation: 40% off deals inside' })).outcome, 'uncertain');
  // 标题不是订单确认
  assert.equal(t.handle(ddEstimated('', { id: 'dd0000000e04', subject: 'Your DoorDash receipt' })).outcome, 'uncertain');
  assert.equal(t.live().length, 0);
  assert.equal(t.pending().length, 3);
  // Uber 打车写着 estimated total：仍不确定
  const ride = F.uberRide({ id: 'ur00000000e1' });
  assert.equal(t.handle(Object.assign({}, ride, { html: ride.html.replace('</body>', '<p>Estimated total</p></body>') })).outcome, 'uncertain');
  // 普通 DoorDash 收据：照常，不标待核对
  assert.equal(t.handle(F.ddReceipt({ id: 'dd0000000e05' })).outcome, 'created');
  assert.equal(t.live()[0].flag_amount_review, false);
});
