'use strict';
/**
 * 小助手（spec 7A.3–7A.6、Task 06）：每条规则的触发与去重、超支速度、打卡里程碑、5 个问题按钮、
 * 工作表不存在时的容错、90 天清理、消息里不含商家和备注。数字均为测试示例。
 * 用与网页相同的服务函数测试，repo 为内存版，“现在”由测试指定。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, memoryRepo, idGen, plain } = require('./helpers/gas');

function aSetup(nowIso, { without = [] } = {}) {
  const g = loadGas();
  const repo = memoryRepo(g, { without });
  const newId = idGen('e');
  g.svcEnsureDefaults(repo);
  let now = new Date(nowIso);
  const t = {
    g, repo, newId,
    now: () => now,
    setNow(iso) { now = new Date(iso); },
    cat(name, type = 'expense') { return repo.list('categories').find((c) => c.name === name && c.type === type).id; },
    save(input) { return g.svcSaveEntry(repo, input, now, newId); },
    expense(amount, cat, local, extra = {}) { return t.save(Object.assign({ type: 'expense', amount, category_id: t.cat(cat), local_datetime: local }, extra)); },
    income(amount, cat, local, extra = {}) { return t.save(Object.assign({ type: 'income', amount, category_id: t.cat(cat, 'income'), local_datetime: local }, extra)); },
    pending(cat, local) {
      const d = g.parseLocalNY(local);
      const e = { id: newId(), type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d), date_ny: g.dateNY(d),
        category_id: t.cat(cat), merchant: 'Apple Pay', channel: 'apple_pay', source_key: 'ap:' + newId(), created_at: now.toISOString(), updated_at: now.toISOString() };
      repo.insert('entries', e);
      return e;
    },
    setBudget(scope, amount) { return g.svcSetBudget(repo, scope, amount, now, newId); },
    /** 以过去某一刻设置预算（模拟以前月份设过的预算） */
    setBudgetAt(scope, amount, iso) { return g.svcSetBudget(repo, scope, amount, new Date(iso), newId); },
    rules() { return g.svcRunAssistantRules(repo, now, newId); },
    msgs() { return plain(repo.list('assistant_messages')); },
    msgsOf(skill) { return t.msgs().filter((m) => m.skill_id === skill); },
    state(k) { const r = repo.list('assistant_state').find((x) => x.state_key === k); return r ? r.value : undefined; },
    unread() { return g.svcBootstrap(repo, now).assistant.unread_count; },
    ask(id) { return plain(g.svcAskAssistant(repo, id, now)); },
    snapshot() { return g.buildSnapshot(g.assistantData_(repo, now), now); }
  };
  return t;
}
// 预算类测试不需要打卡里程碑消息：去掉 checkins 表（与线上“还没重新运行 setupLedger”的打卡部分相同）
const noCheckin = { without: ['checkins'] };

// ---------------- spec 7A.6 ----------------

test('7A.6 预算提醒：餐饮已用 85% → 一条 budget_near（含“餐饮已用 85%”），总预算 17% 不提醒；unread 1 → 读后 0；再运行不重复', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  t.setBudget('total', '1000');
  t.setBudget(t.cat('餐饮'), '200');
  t.expense('170', '餐饮', '2026-03-05T12:00');
  t.rules();
  const near = t.msgsOf('budget_near');
  assert.equal(near.length, 1);
  assert.match(near[0].text, /餐饮已用 85%/);
  assert.match(near[0].text, /本月还剩 21 天/);
  assert.equal(t.msgs().length, 1, '总预算 17% 不提醒，也没有其他消息');
  assert.equal(t.unread(), 1, '红点');
  t.g.svcMarkAssistantRead(t.repo, t.now());
  assert.equal(t.unread(), 0);
  t.rules();
  t.rules();
  assert.equal(t.msgs().length, 1, '再运行不产生第二条');
  assert.equal(t.unread(), 0);
});

test('7A.6 补充：从 over 回到 none 再升到 near 会再次提醒；over → near（退款）不发消息', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  t.setBudget(t.cat('餐饮'), '200');
  const big = t.expense('210', '餐饮', '2026-03-05T12:00');
  t.rules();
  assert.equal(t.msgsOf('budget_over').length, 1, 'none 直接到 over：只发“超出”');
  assert.equal(t.msgsOf('budget_near').length, 0);
  assert.match(t.msgsOf('budget_over')[0].text, /餐饮本月已超出预算 \$10\.00/);
  const key = 'budget:2026-03:cat:' + t.cat('餐饮');
  assert.equal(t.state(key), 'over');

  // 退款 50 → 已用 160 = 80%：over → near，不发消息
  t.expense('50', '餐饮', '2026-03-06T12:00', { is_refund: true, refund_of: big.id });
  t.rules();
  assert.equal(t.state(key), 'near');
  assert.equal(t.msgs().length, 1, 'over → near 不发');

  // 再超出 → 再发一条“超出”
  const extra = t.expense('60', '餐饮', '2026-03-07T12:00');
  t.rules();
  assert.equal(t.msgsOf('budget_over').length, 2);

  // 删除账目回到 none（已用 160 - 退款… 删除大额后已用 = 60 - 50 = 10）→ 不发；再升到 near → 再发 near
  t.g.svcDeleteEntry(t.repo, big.id, t.now());
  t.g.svcDeleteEntry(t.repo, extra.id, t.now());
  t.rules();
  assert.equal(t.state(key), 'none');
  assert.equal(t.msgs().length, 2);
  t.expense('175', '餐饮', '2026-03-08T12:00');   // 已用 125? 退款 -50 + 175 = 125 → 62%，还不够
  t.rules();
  assert.equal(t.msgsOf('budget_near').length, 0);
  t.expense('40', '餐饮', '2026-03-09T12:00');    // 165 → 82.5%
  t.rules();
  assert.equal(t.msgsOf('budget_near').length, 1, 'none → near 再次提醒');
  t.rules();
  assert.equal(t.msgs().length, 3, '幂等');
});

test('预算调高回到 none、预算取消都把状态改回 none；新月份重新计算', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  t.setBudget('total', '100');
  t.expense('90', '餐饮', '2026-03-05T12:00');
  t.rules();
  assert.equal(t.msgsOf('budget_near').length, 1);
  assert.match(t.msgsOf('budget_near')[0].text, /^总预算已用 90%/);
  t.setBudget('total', '500');
  t.rules();
  assert.equal(t.state('budget:2026-03:total'), 'none');
  t.setBudget('total', '100');
  t.rules();
  assert.equal(t.msgsOf('budget_near').length, 2, '调低后再次接近：再提醒');
  t.setBudget('total', '');           // 取消预算
  t.rules();
  assert.equal(t.state('budget:2026-03:total'), 'none');
  // 4 月：新的状态键，从 none 开始
  t.setNow('2026-04-02T16:00:00Z');
  t.setBudget('total', '100');
  t.expense('95', '餐饮', '2026-04-01T12:00');
  t.rules();
  assert.equal(t.state('budget:2026-04:total'), 'near');
  assert.equal(t.msgsOf('budget_near').length, 3);
});

test('7A.6 本月到今天：今天 15 日，1–15 日支出 300、收入 800 → 差额 500，列出各类别；16 日以后的不计入', () => {
  const t = aSetup('2026-03-15T20:00:00Z', noCheckin);
  t.expense('200', '餐饮', '2026-03-02T12:00');
  t.expense('100', '交通', '2026-03-15T09:00');
  t.income('800', '工资', '2026-03-01T09:00');
  t.expense('999', '购物', '2026-03-16T09:00');       // 提前录入的 16 日
  t.income('50', '兼职', '2026-03-20T09:00');
  const a = t.ask('q_month_to_date');
  assert.match(a.text, /支出 \$300\.00，收入 \$800\.00，差额 \$500\.00/);
  assert.deepEqual(a.items, [
    { label: '支出 · 餐饮', amount_cents: 20000 }, { label: '支出 · 交通', amount_cents: 10000 }, { label: '收入 · 工资', amount_cents: 80000 }
  ]);
  t.pending('餐饮', '2026-03-10T12:00');
  assert.match(t.ask('q_month_to_date').text, /有 1 笔未补全/);
  t.expense('900', '购物', '2026-03-03T12:00');
  assert.match(t.ask('q_month_to_date').text, /差额 -\$400\.00/, '负数差额：负号在 $ 前面');
});

test('7A.6 上月同期：3 月 30 日对比 2 月 1–28 日并注明“上月只有 28 天”；2 月 28 日对比 1 月 1–28 日', () => {
  const t = aSetup('2026-03-30T16:00:00Z', noCheckin);
  t.expense('100', '餐饮', '2026-02-01T12:00');
  t.expense('100', '餐饮', '2026-02-28T12:00');
  t.expense('300', '餐饮', '2026-03-29T12:00');
  t.expense('50', '餐饮', '2026-03-31T12:00');       // 明天：不计入
  const a = t.ask('q_vs_last_month');
  assert.match(a.text, /本月 1–30 日支出 \$300\.00；上月同期（2 月 1–28 日）支出 \$200\.00。多花了 \$100\.00（\+50\.0%）/);
  assert.match(a.text, /上月只有 28 天，已与上月全月比较/);

  const u = aSetup('2026-02-28T16:00:00Z', noCheckin);
  u.expense('80', '餐饮', '2026-01-28T12:00');
  u.expense('70', '餐饮', '2026-01-29T12:00');      // 1 月 29 日：不在同期
  u.expense('40', '餐饮', '2026-02-10T12:00');
  u.pending('餐饮', '2026-01-03T12:00');
  const b = u.ask('q_vs_last_month');
  assert.match(b.text, /上月同期（1 月 1–28 日）支出 \$80\.00。少花了 \$40\.00（−50\.0%）/);
  assert.doesNotMatch(b.text, /上月只有/);
  assert.match(b.text, /上月同期有 1 笔未补全/);
  const c = aSetup('2026-03-05T16:00:00Z', noCheckin);
  c.expense('10', '餐饮', '2026-03-01T12:00');
  assert.doesNotMatch(c.ask('q_vs_last_month').text, /%/, '上月同期为 0 时不显示百分比');
});

test('问题：还能花多少（没设预算时提示去设置）、哪个类别花得最多（并列都列出 / 没有支出）、待处理（带去处理动作）', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  assert.match(t.ask('q_budget_left').text, /还没有设置预算/);
  assert.equal(t.ask('q_top_category').text, '本月还没有支出记录。');
  assert.equal(t.ask('q_pending').text, '没有待补全或待核对的账目，账本很整齐！');
  t.setBudget('total', '1000');
  t.setBudget(t.cat('餐饮'), '100');
  t.expense('120', '餐饮', '2026-03-02T12:00');
  t.expense('120', '购物', '2026-03-03T12:00');
  const left = t.ask('q_budget_left');
  assert.match(left.text, /总预算还能花 \$760\.00，本月还剩 21 天/);
  assert.deepEqual(left.items, [{ label: '总预算（剩余）', amount_cents: 76000 }, { label: '餐饮（超出）', amount_cents: 2000 }]);
  const tie = t.ask('q_top_category');
  assert.match(tie.text, /并列最多，各 \$120\.00/);
  assert.deepEqual(tie.items.map((i) => i.label).sort(), ['购物', '餐饮'].sort());
  t.expense('1', '购物', '2026-03-04T12:00');
  assert.match(t.ask('q_top_category').text, /花得最多的是“购物”，共 \$121\.00，占支出 50\.2%/);
  t.pending('餐饮', '2026-02-10T12:00');      // 上个月的待补全也算
  const p = t.ask('q_pending');
  assert.match(p.text, /本月及以前还有 1 笔待补全/);
  assert.equal(p.action, 'goto:pending');
  assert.throws(() => t.ask('nope'), /没有这个问题/);
});

test('问题按钮：顺序与 PRD 6A.4 一致；回答不保存、不产生红点', () => {
  const t = aSetup('2026-03-10T16:00:00Z');
  const before = t.msgs().length;
  const qs = plain(t.g.assistantQuestions());
  assert.deepEqual(qs.map((q) => q.label), ['本月到今天的收支', '这个月还能花多少？', '哪个类别花得最多？', '跟上个月同期比怎么样？', '还有几笔没补全／待核对？']);
  qs.forEach((q) => t.ask(q.id));
  assert.equal(t.msgs().length, before);
  assert.equal(t.unread(), 0);
});

// ---------------- 其他规则的去重 ----------------

test('good_progress：月中以后、已用 ≤ 时间进度 − 15 个百分点（整数比较）、没有待补全；每月一次', () => {
  // 3 月 20 日：时间进度 20/31；阈值 已用 ≤ (2000 − 465)/3100 × 预算 = 49516.1（预算 100000）
  const t = aSetup('2026-03-20T16:00:00Z', noCheckin);
  t.setBudget('total', '1000');
  t.expense('495.17', '餐饮', '2026-03-02T12:00');
  t.rules();
  assert.equal(t.msgsOf('good_progress').length, 0, '49517 > 49516.1：不夸');
  const u = aSetup('2026-03-20T16:00:00Z', noCheckin);
  u.setBudget('total', '1000');
  u.expense('495.16', '餐饮', '2026-03-02T12:00');
  u.rules();
  const m = u.msgsOf('good_progress');
  assert.equal(m.length, 1);
  assert.equal(m[0].text, '本月已经过去 65%，总预算才用了 50%，保持得很好！');
  assert.equal(m[0].dedup_key, 'good_progress:2026-03');
  u.setNow('2026-03-25T16:00:00Z');
  u.rules();
  assert.equal(u.msgsOf('good_progress').length, 1, '每月一次');
  // 月中以前（15 日，2×15 ≤ 31）不夸；有待补全不夸
  const v = aSetup('2026-03-15T16:00:00Z', noCheckin);
  v.setBudget('total', '1000');
  v.rules();
  assert.equal(v.msgsOf('good_progress').length, 0);
  v.setNow('2026-03-20T16:00:00Z');
  v.pending('餐饮', '2026-03-03T12:00');
  v.rules();
  assert.equal(v.msgsOf('good_progress').length, 0);
});

test('last_month_praise：新月份第一次运行时检查上月；未超预算 → 一条（有待补全时注明）；之后不再检查；超预算不夸', () => {
  const t = aSetup('2026-02-10T16:00:00Z', noCheckin);
  t.setBudget('total', '1000');
  t.expense('800', '餐饮', '2026-02-05T12:00');
  t.pending('餐饮', '2026-02-06T12:00');
  t.setNow('2026-03-02T16:00:00Z');
  t.rules();
  const m = t.msgsOf('last_month_praise');
  assert.equal(m.length, 1);
  assert.equal(m[0].text, '上个月（2 月）比预算少花了 $200.00，做得好！（上个月还有 1 笔未补全，结论可能变化）');
  assert.equal(m[0].month, '2026-02');
  assert.equal(m[0].dedup_key, 'last_month_praise:2026-02');
  t.rules();
  t.setNow('2026-03-20T16:00:00Z');
  t.rules();
  assert.equal(t.msgsOf('last_month_praise').length, 1);

  const u = aSetup('2026-02-10T16:00:00Z', noCheckin);
  u.setBudget('total', '100');
  u.expense('150', '餐饮', '2026-02-05T12:00');
  u.setNow('2026-03-01T16:00:00Z');
  u.rules();
  assert.equal(u.msgsOf('last_month_praise').length, 0);
  // 3 月中补了一笔 2 月的退款让 2 月不再超出：本月已经检查过，不再补发（“进入新月份后第一次运行时”）
  u.expense('60', '餐饮', '2026-02-07T12:00', { is_refund: true });
  u.rules();
  assert.equal(u.msgsOf('last_month_praise').length, 0);
  // 上月没有总预算：不夸
  const v = aSetup('2026-03-01T16:00:00Z', noCheckin);
  v.rules();
  assert.equal(v.msgsOf('last_month_praise').length, 0);
});

test('pending_items：笔数超过上次发送笔数、且今天没发过才发；笔数归零后重置', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  t.pending('餐饮', '2026-03-01T12:00');
  const p2 = t.pending('餐饮', '2026-03-02T12:00');
  t.rules();
  const m = t.msgsOf('pending_items');
  assert.equal(m.length, 1);
  assert.equal(m[0].text, '还有 2 笔金额没补全，补上后预算统计会更准哦');
  assert.equal(m[0].action, 'goto:pending');
  t.pending('餐饮', '2026-03-03T12:00');
  t.rules();
  assert.equal(t.msgsOf('pending_items').length, 1, '同一天不再发');
  t.setNow('2026-03-11T16:00:00Z');
  t.rules();
  assert.equal(t.msgsOf('pending_items').length, 2, '第二天 3 > 2：发');
  assert.equal(t.state('pending:last_sent_count'), '3');
  assert.equal(t.state('pending:last_sent_date'), '2026-03-11');
  t.setNow('2026-03-12T16:00:00Z');
  t.rules();
  assert.equal(t.msgsOf('pending_items').length, 2, '没有增加：不发');
  // 全部补完 → 重置为 0；之后再出现 1 笔（第二天）→ 发
  t.repo.list('entries').filter((e) => e.amount_cents === null).forEach((e) => t.g.svcDeleteEntry(t.repo, e.id, t.now()));
  t.rules();
  assert.equal(t.state('pending:last_sent_count'), '0');
  t.setNow('2026-03-13T16:00:00Z');
  t.pending('餐饮', '2026-03-13T08:00');
  t.rules();
  assert.equal(t.msgsOf('pending_items').length, 3);
  assert.ok(p2);
});

test('apple_pay_rate_limited：没有收件箱数据时什么都不做；有标记行时每行最多一次', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  t.rules();
  assert.equal(t.msgsOf('apple_pay_rate_limited').length, 0);
  const snap = t.snapshot();
  snap.rate_limited_markers = ['2026-03-10T15:00:00Z'];
  const first = plain(t.g.runSkills(snap, {}));
  const rl = first.messages.filter((m) => m.skill_id === 'apple_pay_rate_limited');
  assert.equal(rl.length, 1);
  assert.equal(rl[0].dedup_key, 'rate_limited:2026-03-10T15:00:00Z');
  const again = plain(t.g.runSkills(snap, first.changes));
  assert.equal(again.messages.filter((m) => m.skill_id === 'apple_pay_rate_limited').length, 0);
});

test('checkin_milestone：第一次记账 → 1 天里程碑（开心表情）；同时跨过几个只发最高的；400、500 用通用文字；每个只发一次', () => {
  const t = aSetup('2026-10-14T16:00:00Z');
  t.expense('5', '餐饮', '2026-10-14T08:00');
  t.rules();
  let m = t.msgsOf('checkin_milestone');
  assert.equal(m.length, 1);
  assert.equal(m[0].dedup_key, 'checkin:1');
  assert.match(m[0].text, /第一次打卡/);
  assert.equal(t.g.svcGetAssistant(t.repo, t.now()).messages[0].mood, 'happy');

  // 补打卡后一下子到 46 天：1 之后的 3、7、14、30 只发 30
  for (let i = 1; i <= 45; i++) t.repo.insert('checkins', { date_ny: t.g.addDaysNY('2026-10-14', -i * 2), first_entry_at: '2026-01-01T00:00:00.000Z' });
  t.rules();
  m = t.msgsOf('checkin_milestone');
  assert.deepEqual(m.map((x) => x.dedup_key), ['checkin:1', 'checkin:30']);
  assert.match(m[1].text, /30 天/);
  t.rules();
  assert.equal(t.msgsOf('checkin_milestone').length, 2);

  const texts = new Set();
  for (const n of [1, 3, 7, 14, 30, 50, 100, 200, 365]) texts.add(t.g.checkinMilestoneText(n));
  assert.equal(texts.size, 9, '每个里程碑文字不同');
  assert.match(t.g.checkinMilestoneText(400), /累计打卡 400 天/);
  assert.match(t.g.checkinMilestoneText(500), /累计打卡 500 天/);

  // 399 → 400 → 500
  const u = aSetup('2026-10-14T16:00:00Z');
  for (let i = 0; i < 399; i++) u.repo.insert('checkins', { date_ny: u.g.addDaysNY('2026-10-13', -i), first_entry_at: '2025-01-01T00:00:00.000Z' });
  u.rules();
  assert.deepEqual(u.msgsOf('checkin_milestone').map((x) => x.dedup_key), ['checkin:365']);
  u.expense('5', '餐饮', '2026-10-14T08:00');      // 第 400 天
  u.rules();
  assert.deepEqual(u.msgsOf('checkin_milestone').map((x) => x.dedup_key), ['checkin:365', 'checkin:400']);
  for (let i = 0; i < 100; i++) u.repo.insert('checkins', { date_ny: u.g.addDaysNY('2020-01-01', i), first_entry_at: '2020-01-01T00:00:00.000Z' });
  u.rules();
  assert.deepEqual(u.msgsOf('checkin_milestone').map((x) => x.dedup_key), ['checkin:365', 'checkin:400', 'checkin:500']);
});

test('只发一次的去重键记在 assistant_state：90 天后消息被清理，里程碑/本月夸奖也不会再发', () => {
  const t = aSetup('2026-10-14T16:00:00Z');
  t.expense('5', '餐饮', '2026-10-14T08:00');
  t.rules();
  assert.equal(t.msgsOf('checkin_milestone').length, 1);
  assert.ok(t.state('checkin:1'));
  t.setNow('2027-02-01T16:00:00Z');
  assert.equal(t.g.svcPurgeAssistantMessages(t.repo, t.now()).purged, 1);
  t.rules();
  assert.equal(t.msgsOf('checkin_milestone').length, 0, '清理后不会重发 1 天里程碑');
});

// ---------------- budget_pace ----------------

function paceSetup(dayIso, used) {
  const t = aSetup(dayIso, noCheckin);
  t.setBudget('total', '1000');                     // 100000 美分；3 月 L = 31
  if (used) t.expense(used, '餐饮', '2026-03-01T12:00');
  return t;
}

test('budget_pace：6 日不提醒；7 日推算超支 → 一条（文本含每日平均预算 / 目前日均支出）；同月再运行不再发', () => {
  const d6 = paceSetup('2026-03-06T17:00:00Z', '300');   // 30000 × 31 > 100000 × 6，但还没到 7 日
  d6.rules();
  assert.equal(d6.msgsOf('budget_pace').length, 0);

  const t = paceSetup('2026-03-07T17:00:00Z', '300');    // 30000 × 31 = 930000 > 700000
  t.rules();
  const m = t.msgsOf('budget_pace');
  assert.equal(m.length, 1);
  // 每日平均预算 100000 ÷ 31 = 3225.8 → $32.26；目前日均 30000 ÷ 7 = 4285.7 → $42.86
  assert.equal(m[0].text, '喵～本月每日平均预算 $32.26，目前日均支出 $42.86，照这个速度月底可能会超支哦');
  assert.equal(m[0].dedup_key, 'budget_pace:2026-03');
  assert.deepEqual(JSON.parse(m[0].items_json).slice(0, 2), [{ label: '每日平均预算', amount_cents: 3226 }, { label: '目前日均支出', amount_cents: 4286 }]);
  t.rules();
  t.setNow('2026-03-20T17:00:00Z');
  t.expense('100', '餐饮', '2026-03-20T12:00');
  t.rules();
  assert.equal(t.msgsOf('budget_pace').length, 1, '同一个月最多一次');
  // 下个月可以再提醒
  t.setNow('2026-04-08T16:00:00Z');
  t.expense('400', '餐饮', '2026-04-02T12:00');
  t.rules();
  assert.equal(t.msgsOf('budget_pace').length, 2);
});

test('budget_pace：已经超出不发；没有总预算不发；推算正好等于预算不发（整数比较）', () => {
  const over = paceSetup('2026-03-10T16:00:00Z', '1200');
  over.rules();
  assert.equal(over.msgsOf('budget_pace').length, 0);
  assert.equal(over.msgsOf('budget_over').length, 1);

  const noTotal = aSetup('2026-03-10T16:00:00Z', noCheckin);
  noTotal.setBudget(noTotal.cat('餐饮'), '100');
  noTotal.expense('90', '餐饮', '2026-03-02T12:00');
  noTotal.rules();
  assert.equal(noTotal.msgsOf('budget_pace').length, 0, '只看总预算');

  // 3 月 31 天、7 日：已用 × 31 = 100000 × 7 ⇔ 已用 = 22580.6；22580 不发，22581 发
  const eq = paceSetup('2026-03-07T17:00:00Z', '225.80');
  eq.rules();
  assert.equal(eq.msgsOf('budget_pace').length, 0);
  const gt = paceSetup('2026-03-07T17:00:00Z', '225.81');
  gt.rules();
  assert.equal(gt.msgsOf('budget_pace').length, 1);
});

// ---------------- 容错、清理、隐私 ----------------

test('工作表不存在（还没重新运行 setupLedger）：规则跳过，不出错；打开、保存、提问、标已读都正常', () => {
  const t = aSetup('2026-03-10T16:00:00Z', { without: ['assistant_messages', 'assistant_state', 'checkins'] });
  t.setBudget('total', '100');
  t.expense('95', '餐饮', '2026-03-05T12:00');
  assert.deepEqual(plain(t.rules()), { ran: false, added: 0 });
  const boot = plain(t.g.svcBootstrap(t.repo, t.now()));
  assert.deepEqual(boot.assistant, { ready: false, unread_count: 0 });
  assert.equal(boot.checkin.ready, false);
  assert.equal(boot.checkin.cumulative, 0);
  const a = plain(t.g.svcGetAssistant(t.repo, t.now()));
  assert.equal(a.ready, false);
  assert.deepEqual(a.messages, []);
  assert.equal(a.questions.length, 5);
  assert.match(t.ask('q_budget_left').text, /总预算还能花 \$5\.00/);
  assert.deepEqual(plain(t.g.svcMarkAssistantRead(t.repo, t.now())), { unread_count: 0, marked: 0 });
  assert.deepEqual(plain(t.g.svcPurgeAssistantMessages(t.repo, t.now())), { purged: 0 });
  assert.equal(t.g.svcBackfillCheckins(t.repo), 0);
  assert.deepEqual(Object.keys(t.repo.tables).filter((n) => /assistant|checkin/.test(n)), [], '没有建表');
});

test('每日清理：只删除 90 天前的小助手消息；打卡和状态不动', () => {
  const t = aSetup('2026-06-01T12:00:00Z');
  const ins = (id, created) => t.repo.insert('assistant_messages', { id, created_at: created, skill_id: 'budget_near', dedup_key: id, month: '2026-01', text: 'x' });
  ins('old', '2026-03-02T11:59:00.000Z');     // 91 天前
  ins('edge', '2026-03-03T12:00:00.000Z');    // 正好 90 天：保留
  ins('new', '2026-05-30T12:00:00.000Z');
  ins('bad', 'not-a-date');                   // 无法识别：保留
  t.repo.insert('checkins', { date_ny: '2025-01-01', first_entry_at: '2025-01-01T12:00:00.000Z' });
  t.repo.insert('assistant_state', { state_key: 'checkin:1', value: 'x', updated_at: '2025-01-01T12:00:00.000Z' });
  assert.equal(t.g.svcPurgeAssistantMessages(t.repo, t.now()).purged, 1);
  assert.deepEqual(t.msgs().map((m) => m.id), ['edge', 'new', 'bad']);
  assert.equal(t.repo.list('checkins').length, 1);
  assert.equal(t.repo.list('assistant_state').length, 1);
});

test('对话窗口只显示最近 30 天，旧的在上新的在下；开心表情只用于夸奖和里程碑', () => {
  const t = aSetup('2026-06-01T12:00:00Z');
  const ins = (id, created, skill) => t.repo.insert('assistant_messages', { id, created_at: created, skill_id: skill, dedup_key: id, month: '2026-05', text: id });
  ins('b', '2026-05-20T12:00:00.000Z', 'budget_over');
  ins('a', '2026-04-20T12:00:00.000Z', 'budget_near');    // 超过 30 天：不显示
  ins('c', '2026-05-10T12:00:00.000Z', 'good_progress');
  ins('d', '2026-05-30T12:00:00.000Z', 'checkin_milestone');
  ins('e', '2026-05-31T12:00:00.000Z', 'last_month_praise');
  ins('f', '2026-05-31T12:00:00.000Z', 'budget_pace');
  ins('g', '2026-05-31T12:00:00.000Z', 'pending_items');
  const v = plain(t.g.svcGetAssistant(t.repo, t.now()));
  assert.deepEqual(v.messages.map((m) => m.id), ['c', 'b', 'd', 'e', 'f', 'g']);
  assert.deepEqual(v.messages.map((m) => m.mood), ['happy', 'normal', 'happy', 'happy', 'normal', 'normal']);
  assert.equal(v.unread_count, 7, '未读数包括所有未读（标已读时也全部标记）');
});

test('规则出错不影响保存：保存仍成功；打卡写入失败也不影响保存', () => {
  const { createBackend } = require('./helpers/harness');
  const { g, ss } = createBackend();
  const real = g.svcRunAssistantRules;
  const realErr = console.error;
  console.error = () => {};
  try {
    g.svcRunAssistantRules = () => { throw new Error('boom'); };
    const e = g.api_saveEntry({ type: 'expense', amount: '12', category_id: 'exp_dining', local_datetime: '2026-01-05T12:00' });
    assert.equal(e.amount_cents, 1200);
    assert.ok(g.api_bootstrap().current_month, '打开网页也不受影响');
    g.svcRunAssistantRules = real;
    const realRecord = g.svcRecordCheckin_;
    g.svcRecordCheckin_ = () => { throw new Error('sheet error'); };
    const e2 = g.api_saveEntry({ type: 'expense', amount: '3', category_id: 'exp_dining', local_datetime: '2026-01-06T12:00' });
    assert.equal(e2.amount_cents, 300);
    g.svcRecordCheckin_ = realRecord;
    assert.equal(g.sheetRepo_(ss).list('entries').length, 2);
  } finally {
    console.error = realErr;
    g.svcRunAssistantRules = real;
  }
});

test('隐私：快照、消息和问题回答里都没有商家和备注', () => {
  const t = aSetup('2026-03-20T16:00:00Z');
  t.setBudgetAt('total', '300', '2026-02-10T12:00:00Z');
  t.setBudget(t.cat('餐饮'), '100');
  t.setBudget(t.cat('购物'), '50');
  const secret = { merchant: 'SECRET-SHOP-ZZ', note: 'SECRET-NOTE-QQ' };
  t.expense('85', '餐饮', '2026-03-02T12:00', secret);
  t.expense('60', '购物', '2026-03-03T12:00', secret);
  t.expense('20', '餐饮', '2026-02-03T12:00', secret);
  t.income('500', '工资', '2026-03-01T09:00', secret);
  t.pending('交通', '2026-03-04T12:00');
  t.rules();
  assert.ok(t.msgs().length >= 4, '产生了若干条消息');
  const answers = plain(t.g.assistantQuestions()).map((q) => t.ask(q.id));
  const blob = JSON.stringify([plain(t.snapshot()), t.msgs(), answers, plain(t.g.svcGetAssistant(t.repo, t.now()))]);
  assert.doesNotMatch(blob, /SECRET/);
  assert.doesNotMatch(blob, /Apple Pay/, '待补全账目的商家也不出现');
});

test('attentionMonths：多个月份从早到晚，已删除和以后的月份不算，各月之和 = attentionCounts.total，listMonth 附带清单', () => {
  const t = aSetup('2026-03-10T16:00:00Z', noCheckin);
  assert.deepEqual(plain(t.g.attentionMonths(t.repo.list('entries'), '2026-03')), []);
  t.pending('餐饮', '2026-03-05T12:00');
  t.pending('餐饮', '2026-01-05T12:00');
  t.pending('购物', '2026-01-06T12:00');
  const gone = t.pending('餐饮', '2025-12-06T12:00');
  t.g.svcDeleteEntry(t.repo, gone.id, t.now());
  t.pending('餐饮', '2026-05-06T12:00');      // 以后的月份不算
  t.expense('10', '餐饮', '2026-02-03T12:00'); // 正常账目不算
  const entries = t.repo.list('entries');
  const ms = plain(t.g.attentionMonths(entries, '2026-03'));
  assert.deepEqual(ms, [{ month: '2026-01', count: 2 }, { month: '2026-03', count: 1 }]);
  assert.equal(ms.reduce((a, x) => a + x.count, 0), t.g.attentionCounts(entries, '2026-03').total);
  const list = plain(t.g.svcListMonth(t.repo, '2026-03', 'attention', t.now()));
  assert.deepEqual(list.attention_months, ms);
  assert.equal(t.g.svcListMonth(t.repo, '2026-03', 'all', t.now()).attention_months, undefined);
});
