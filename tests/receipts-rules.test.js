'use strict';
/**
 * 外卖收据：文字处理与各平台规则（spec 6.5；§10 切片 2 的平台专项）。全部使用手写的合成样本。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const F = require('./fixtures/synthetic-mail');

const g = loadGas();
const P = g.receiptPlatforms();
const parse = (m, platforms = P) => g.parseReceiptMessage(m, platforms);

// ---------------- 通用：HTML → 文本、金额、标签 ----------------

test('HTML → 文本：去掉 head/style/script/注释，表格同一行的单元格留在同一行，实体解码', () => {
  const t = g.htmlToText('<html><head><style>p{}</style><script>var x=1</script></head><body><!-- c -->' +
    '<table><tr><td>Total</td><td>&#36;23.45</td></tr><tr><td>Tip&nbsp;&amp;&nbsp;fee</td><td>$1.00</td></tr></table><p>a<br>b</p></body></html>');
  assert.deepEqual(t.split('\n'), ['Total $23.45', 'Tip & fee $1.00', 'a', 'b']);
});

test('NFKC：全角数字、全角冒号、全角 $ 变成半角；零宽字符去掉', () => {
  assert.equal(g.normalizeReceiptText('总计：＄２５.５０​'), '总计:$25.50');
  assert.equal(g.extractLabeledAmount('实付金额：＄１,２３４.５６', ['实付金额'], []).cents, 123456);
});

test('金额写法：$1,234.56、US$1,234.56、1,234.56 USD、$ 12.30 → 美分；¥、CA$、CAD、元 → 非美元', () => {
  const one = (s) => g.extractLabeledAmount('Total ' + s, ['Total'], []);
  assert.equal(one('$1,234.56').cents, 123456);
  assert.equal(one('US$1,234.56').cents, 123456);
  assert.equal(one('1,234.56 USD').cents, 123456);
  assert.equal(one('$ 12.30').cents, 1230);
  assert.equal(one('USD 7.05').cents, 705);
  for (const s of ['¥98.00', 'CA$12.00', 'AU$5.00', 'CAD 12.00', '45.00 元', '€9.99']) {
    const r = one(s);
    assert.equal(r.cents, null, s);
    assert.equal(r.reason, 'CURRENCY_UNKNOWN', s);
  }
  assert.equal(one('23.45').reason, 'TOTAL_NOT_FOUND', '没有币种标记的数字不当作金额');
  assert.equal(g.extractLabeledAmount('Total 23.45', ['Total'], [], { bareIsUsd: true }).cents, 2345);
});

test('总额而非小计：只认总额标签，Subtotal / 小计 / Total savings 不算', () => {
  const text = ['Subtotal $18.00', 'Total savings $3.00', 'Total (incl. tax): $23.45', '小计 $5.00'].join('\n');
  const r = g.extractLabeledAmount(text, ['Total', '总计'], ['Subtotal', '小计']);
  assert.equal(r.cents, 2345);
  assert.equal(r.label, 'Total');
  assert.equal(g.extractLabeledAmount('Subtotal $18.00\nTax $1.00', ['Total'], ['Subtotal']).reason, 'TOTAL_NOT_FOUND');
});

test('标签行没有金额时看下一行；多个不同的总额 → MULTIPLE_TOTALS；相同的重复出现 → 正常', () => {
  assert.equal(g.extractLabeledAmount('Total\n$23.45', ['Total'], []).cents, 2345);
  const multi = g.extractLabeledAmount('Total $23.45\nOrder Total $25.00', ['Order Total', 'Total'], []);
  assert.equal(multi.cents, null);
  assert.equal(multi.reason, 'MULTIPLE_TOTALS');
  assert.equal(g.extractLabeledAmount('Total $23.45\nTotal: $23.45', ['Total'], []).cents, 2345);
});

test('发件人：只取显示名和域名；子域名也算同一平台', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(g.parseFromHeader('"Uber Eats" <uber@uber.com>'))), { name: 'Uber Eats', domain: 'uber.com' });
  assert.equal(g.senderDomainIn(g.parseFromHeader('x@mail.doordash.com'), ['doordash.com']), true);
  assert.equal(g.senderDomainIn(g.parseFromHeader('x@notdoordash.com'), ['doordash.com']), false);
  assert.equal(g.senderDomainIn(g.parseFromHeader(''), ['doordash.com']), false);
});

test('合并搜索：所有参与记账的平台放进一个 {…}，加 newer_than:3d；关闭的平台不搜索', () => {
  assert.equal(g.buildReceiptQuery(P),
    'newer_than:3d ({from:(doordash.com) from:(uber.com)} OR ({category:purchases subject:receipt subject:invoice subject:payment subject:收据 subject:订单 subject:order subject:confirmation} -from:(doordash.com) -from:(uber.com)))');
  const off = P.map((p) => (p.id === 'uber' || p.id === 'ubereats' ? Object.assign({}, p, { enabled: false }) : p));
  assert.doesNotMatch(g.buildReceiptQuery(off).split(' OR ')[0], /uber\.com/);
  assert.match(g.buildReceiptQuery([]), /category:purchases/);
});

// ---------------- DoorDash ----------------

test('DoorDash：收据 → 实付总额（含税费小费、扣除优惠）而不是小计；订单号来自订单链接', () => {
  const r = parse(F.ddReceipt());
  assert.equal(r.platform.id, 'doordash');
  assert.equal(r.kind, 'receipt');
  assert.equal(r.cents, 2345);
  assert.equal(r.orderRef, 'a1b2c3d4-0001');
  assert.equal(parse(F.ddReceiptNoRef()).orderRef, null);
});

test('DoorDash：退款 → refund，金额与订单号；促销 → other；DashPass 收据（主题同时像收据）→ uncertain', () => {
  const r = parse(F.ddRefund());
  assert.equal(r.kind, 'refund');
  assert.equal(r.cents, 500);
  assert.equal(r.orderRef, 'a1b2c3d4-0001');
  assert.equal(parse(F.ddPromo()).kind, 'other');
  assert.equal(parse(F.mail({ id: 'dd00000000x1', from: 'DoorDash <no-reply@doordash.com>', subject: 'Your DashPass receipt',
    html: F.receiptHtml({ title: 'DashPass', rows: [['Total', '$9.99']] }) })).kind, 'uncertain');
  assert.equal(parse(F.mail({ id: 'dd00000000x2', from: 'DoorDash <no-reply@doordash.com>', subject: 'DashPass: free delivery all week',
    html: '<p>x</p>' })).kind, 'other');
});

// ---------------- Uber Eats ----------------

test('Uber Eats：收据 → 入账金额 = Total；订单号来自链接', () => {
  const r = parse(F.ueReceipt());
  assert.equal(r.platform.id, 'ubereats');
  assert.equal(r.kind, 'receipt');
  assert.equal(r.cents, 3120);
  assert.equal(r.orderRef, 'f00d0000-1111-2222');
  assert.equal(parse(F.ueRefund()).kind, 'refund');
});

test('Uber 打车收据 → Uber 交通支出；页脚带 Uber Eats 广告的打车收据仍是打车', () => {
  const ride = parse(F.uberRide());
  assert.deepEqual([ride.platform.id, ride.platform.category, ride.kind, ride.cents], ['uber', '交通', 'receipt', 1875]);
  const footer = F.uberRide({ footer: true });
  assert.match(g.htmlToText(footer.html), /Uber Eats/, '样本正文里确实有 Uber Eats 字样');
  assert.equal(parse(footer).platform.id, 'uber');
  assert.equal(parse(footer).kind, 'receipt');
  // 页脚出现 Uber Eats 不会把行程误分为外卖。
  const vague = Object.assign({}, footer, { subject: 'Your receipt' });
  assert.deepEqual([parse(vague).platform.id, parse(vague).kind], ['uber', 'receipt']);
});

test('Uber One、Uber Cash、Uber Eats 促销 → other；有金额但看不出是外卖还是打车 → uncertain', () => {
  assert.equal(parse(F.uberOne()).kind, 'other');
  assert.equal(parse(F.uberCash()).kind, 'other');
  assert.equal(parse(F.uberEatsPromo()).kind, 'other');
  assert.equal(parse(F.uberUnknownWithAmount()).platform.id, 'uber');
  assert.equal(parse(F.uberUnknownWithAmount()).kind, 'receipt');
  // 发件人显示名是 Uber Eats（主题没写）也算外卖
  const byName = F.ueReceipt({ id: 'ue00000000x1' });
  byName.subject = 'Your order with Zebracorn Tacos';
  assert.equal(parse(byName).kind, 'receipt');
});

// ---------------- 注册表 ----------------

test('中文 Uber：总计 US$ 金额在同一行、下一行或嵌套 HTML 中都读取总额，页脚外卖广告不改变交通分类', () => {
  const samples = [F.uberChineseRide(), F.uberChineseRide({ split: true }),
    Object.assign({}, F.uberChineseRide(), { html: '', text: '总计 US$27.60\n行程车费 US$21.00' }),
    Object.assign({}, F.uberChineseRide(), { html: '', text: '总计\nUS$27.60\n行程车费 US$21.00' })];
  for (const m of samples) {
    const r = parse(m);
    assert.deepEqual([r.platform.id, r.platform.category, r.kind, r.cents, r.label],
      ['uber', '交通', 'receipt', 2760, '总计']);
  }
});

test('中文 Uber Eats：邮件头标为外卖时总计金额记为餐饮', () => {
  const m = Object.assign({}, F.uberChineseRide(), { from: 'Uber Eats <receipts@uber.com>', subject: '您的 Uber Eats 订单收据' });
  const r = parse(m);
  assert.deepEqual([r.platform.id, r.platform.category, r.kind, r.cents], ['ubereats', '餐饮', 'receipt', 2760]);
});

test('中文总计：小计/车费不可替代总额，冲突总额和非美元保留待补全', () => {
  const cases = [
    ['行程车费 US$21.00\n小计 US$21.00', 'TOTAL_NOT_FOUND'],
    ['总计优惠 US$3.00', 'TOTAL_NOT_FOUND'],
    ['总计\n行程车费 US$21', 'TOTAL_NOT_FOUND'],
    ['总计\n小计 $21', 'TOTAL_NOT_FOUND'],
    ['总计 US$27.60\nTotal US$29.60', 'MULTIPLE_TOTALS'],
    ['总计 CA$27.60', 'CURRENCY_UNKNOWN']
  ];
  for (const [text, reason] of cases) {
    const r = parse(Object.assign({}, F.uberChineseRide(), { html: '', text }));
    assert.equal(r.cents, null, text);
    assert.equal(r.reason, reason, text);
  }
});

test('下一行必须是单独金额：不能从其他标签取钱，也不能越过小计行寻找金额', () => {
  for (const text of ['Total\nFare $21', 'Total\n小计 $21', 'Total\n小计\nUS$21', 'Total\n$21 $22']) {
    assert.equal(g.extractLabeledAmount(text, ['Total'], ['Subtotal', '小计']).reason, 'TOTAL_NOT_FOUND', text);
  }
  for (const amount of ['US$27.60', '1,234.56 USD', 'US$1,234,567.89']) {
    assert.ok(g.extractLabeledAmount('Total\n' + amount, ['Total'], []).cents > 0, amount);
  }
});

test('注册表：DoorDash、Uber 打车、Uber Eats 都有平台字段与预期类别', () => {
  assert.deepEqual(Array.from(P, (p) => p.id), ['doordash', 'uber', 'ubereats']);
  for (const p of P) {
    for (const f of ['id', 'displayName', 'support_status', 'gmailQuery', 'merchantAliases', 'category']) assert.ok(p[f] !== undefined, p.id + ' ' + f);
    for (const f of ['matchSender', 'classify', 'extractTotal', 'extractRefund', 'extractOrderRef']) assert.equal(typeof p[f], 'function', p.id + ' ' + f);
    assert.equal(p.enabled, true);
    assert.equal(p.support_status, 'unverified');
    assert.equal(p.category, p.id === 'uber' ? '交通' : '餐饮');
  }
  assert.deepEqual(Array.from(P, (p) => p.displayName), ['DoorDash', 'Uber', 'Uber Eats']);
});

test('发件人同时匹配两个平台 → PLATFORM_AMBIGUOUS；一个都不匹配 → no_platform', () => {
  const clone = Object.assign({}, g.RECEIPT_PLATFORM_DOORDASH, { id: 'dd2', displayName: 'DD2' });
  const r = parse(F.ddReceipt(), P.concat([clone]));
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(Array.from(r.platformIds), ['doordash', 'dd2']);
  assert.equal(parse(F.mail({ id: 'xx0000000001', from: 'Someone <a@example.test>', subject: 'Receipt', html: '<p>Total $1.00</p>' })).status, 'no_platform');
});

// ---------------- 主题里同时有收据和促销/会员字样（评审 M1） ----------------

test('收据主题里带 Deal / DashPass / 折扣 等字样 → uncertain（列入待查看），不会被当作促销悄悄忽略', () => {
  const html = F.receiptHtml({ title: 'x', rows: [['Subtotal', '$18.00'], ['Total', '$23.45']] });
  const cases = [
    ['DoorDash <no-reply@doordash.com>', 'Order Confirmation for Big Deal Burgers'],
    ['DoorDash <no-reply@doordash.com>', 'Your DashPass order from Noodle Bar'],
    ['Uber Eats <uber@uber.com>', 'Your Uber Eats order with Hot Deals Pizza'],
    ['DoorDash <no-reply@doordash.com>', 'Your refund for Big Deal Burgers']
  ];
  cases.forEach(([from, subject], i) => {
    assert.equal(parse(F.mail({ id: 'mx00000000' + String(i).padStart(2, '0'), from, subject, html })).kind, 'uncertain', subject);
  });
  // 打车收据按主题头归入 Uber；促销邮件本身才忽略。
  const ride = F.uberRide({ footer: true });
  assert.equal(parse(Object.assign({}, ride, { subject: 'Your trip with Uber — 20% off your next ride' })).kind, 'other');
  assert.equal(parse(ride).kind, 'receipt');
});

test('DoorDash：营销主题“Order from … tonight”“Hungry? Order from 5 new restaurants near you”（没有 Total 行）→ other，不入账', () => {
  const { memoryRepo, idGen } = require('./helpers/gas');
  const repo = memoryRepo(g);
  g.svcEnsureDefaults(repo);
  const subjects = ['Order from Chipotle tonight', 'Hungry? Order from 5 new restaurants near you'];
  subjects.forEach((subject, i) => {
    const m = F.mail({ id: 'mk00000000' + i, from: 'DoorDash <deals@doordash.com>', subject,
      html: `<p>${F.BODY_MARKER} and more are on DoorDash.</p><p>$0 delivery fee on orders over $15. Order now.</p>` });
    assert.equal(parse(m).kind, 'other', subject);
    const r = g.svcHandleReceiptMessage(repo, m, P, new Date('2026-10-15T16:00:00Z'), idGen('e'));
    assert.equal(r.outcome, 'ignored_not_receipt', subject);
  });
  assert.equal(repo.list('entries').length, 0);
  // 真正的收据写法仍可识别
  assert.equal(parse(F.mail({ id: 'mk0000000009', from: 'DoorDash <no-reply@doordash.com>', subject: 'Your order from Noodle Bar',
    html: F.receiptHtml({ title: 'x', rows: [['Total', '$23.45']] }) })).kind, 'receipt');
});

test('消费证据：姓名或品牌加金额不能代替收据，个性化促销忽略', () => {
  const cases = [
    ['Uber <news@uber.com>', 'Sam, something for you', 'Hi Sam\nTotal $30 minimum spend\nSave $10 on your next ride', 'other'],
    ['DoorDash <news@doordash.com>', 'Sam，今天点什么', 'Sam，满 $30 减 $10\n总计 $30 起送', 'other'],
    ['Uber <news@uber.com>', 'Hello Sam', 'Hi Sam\nTotal $30.00', 'uncertain'],
    ['Uber <news@uber.com>', 'Ride with Uber tonight', 'Total $30.00', 'uncertain']
  ];
  for (const [from, subject, text, expected] of cases) {
    assert.equal(parse(F.mail({ id: 'ev0000000001', from, subject, text })).kind, expected, subject);
  }
});

test('无姓名真实收据：各平台支持中英文实付标签和跨行 HTML', () => {
  for (const [from, subject] of [['DoorDash <receipts@doordash.com>', 'Payment received'],
    ['Uber <receipts@uber.com>', 'Your trip receipt'], ['Uber Eats <receipts@uber.com>', '您的订单已支付']]) {
    for (const label of ['Total', 'Grand Total', 'Amount Paid', '总计', '实付']) {
      const r = parse(F.mail({ id: 'ev0000000002', from, subject,
        html: '<p>Payment received</p><div>' + label + '</div><div>US$26.80</div><p>Subtotal $20.00</p>' }));
      assert.equal(r.kind, 'receipt', from + label);
      assert.equal(r.cents, 2680, from + label);
    }
  }
});

test('订单未支付不自动记账；真实收据中的下次优惠页脚不妨碍入账', () => {
  const unpaid = F.ddReceipt();
  unpaid.html += '<p>Payment pending — amount due $23.45</p>';
  assert.equal(parse(unpaid).kind, 'uncertain');
  const paid = F.ddReceipt();
  paid.html += '<p>Sam, save $10 on your next order over $30</p>';
  assert.equal(parse(paid).kind, 'receipt');
  assert.equal(parse(paid).cents, 2345);
});

test('总额标签不能把满减/门槛/折扣或负金额当实际支出', () => {
  for (const text of ['Total $30 minimum spend', 'Total $30 or more', 'Total (minimum spend) $30',
    'Total $30\nminimum spend', '总计 $30 起送', '实付 $30 可享优惠', 'Amount Paid -$30']) {
    const r = parse(Object.assign({}, F.ddReceipt(), { html: '', text }));
    assert.equal(r.cents, null, text);
  }
});

test('未来订单和行程优惠不构成已消费证据，促销和收据主题冲突进入待查看', () => {
  for (const [from, subject] of [
    ['Uber <news@uber.com>', 'Your next ride'],
    ['DoorDash <news@doordash.com>', '您的订单满30减10'],
    ['Uber Eats <news@uber.com>', 'Your next Uber Eats order'],
    ['Uber <receipts@uber.com>', 'Your trip receipt with an offer']
  ]) {
    const r = parse(F.mail({ id: 'ev0000000030', from, subject, text: 'Hi Sam\nTotal $30.00' }));
    assert.notEqual(r.kind, 'receipt', subject);
  }
});

test('收据规则可以先于文字工具初始化，不依赖文件加载顺序', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { MAIN } = require('./helpers/gas');
  const files = ['core/platforms/uber.js', 'core/platforms/ubereats.js', 'core/platforms/doordash.js',
    'core/receipt_pipeline.js', 'core/receipt_text.js'];
  for (const combined of [false, true]) {
    const ctx = vm.createContext({});
    if (combined) vm.runInContext(files.map(f => fs.readFileSync(path.join(MAIN, f), 'utf8')).join('\n'), ctx);
    else for (const file of files) vm.runInContext(fs.readFileSync(path.join(MAIN, file), 'utf8'), ctx);
    for (const rule of [ctx.UBER_RULES_, ctx.UBEREATS_RULES_, ctx.DOORDASH_RULES_]) {
      assert.ok(rule.totalLabels.every(v => typeof v === 'string'));
      assert.ok(rule.excludeLabels.every(v => typeof v === 'string'));
    }
    assert.equal(ctx.RECEIPT_PLATFORM_UBER.extractTotal('实付 US$26.80').cents, 2680);
    assert.equal(ctx.genericTotal_('Grand Total $26.80'), 2680);
  }
});
