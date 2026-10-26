'use strict';
/**
 * 本地预览（给开发和评审用，不连接任何 Google 服务）：
 *   node tools/preview.js          然后在浏览器打开 http://localhost:8787
 *   手机宽度：浏览器开发者工具里选 iPhone（375×812），或把窗口缩窄。
 *
 * 页面是真实的 apps/main/ui（样式和脚本原样），后端是 tests/helpers/harness.js 里的真实服务器代码
 * + 假表格，数据只存在这个进程的内存里，关掉就没了。
 * 预置数据：本月若干账目 + 一笔待补全，过去 14 个月（跨年）的收支，以及总预算 / 类别预算（含过去月份的预算历史）；
 * 打卡累计 46 天、连续 12 天；小助手消息（打卡里程碑、超支速度、预算接近 / 超出、待处理等，左上角有红点）。
 * 页面顶部多一条“预览工具条”（正式环境没有）：
 *   - “下次保存失败”：勾上后点保存，会看到失败的抖动和提示（内容不丢）
 *   - “慢网络”：保存多等 2 秒，方便看转圈
 *   - 地址加 ?reduced=1 可模拟手机的“减少动态效果”
 */
const http = require('node:http');
const { createBackend } = require('../tests/helpers/harness');

const PORT = Number(process.env.PORT || 8787);
const backend = createBackend();
const g = backend.g;

function seed() {
  const boot = g.api_bootstrap();
  const m = boot.current_month;
  const repoNow = g.sheetRepo_(backend.ss);
  // 打卡：今天（下面记账时自动打卡）+ 之前连续 11 天 = 连续 12 天；断一天后，更早再零散打卡 34 天 → 累计 46 天
  const today = boot.today_ny;
  const past = [];
  for (let i = 1; i <= 11; i++) past.push(g.addDaysNY(today, -i));
  for (let i = 0; past.length < 45; i++) past.push(g.addDaysNY(today, -13 - i - Math.floor(i / 3)));
  past.forEach((d) => repoNow.insert('checkins', { date_ny: d, first_entry_at: g.parseLocalNY(d + 'T20:00').toISOString() }));
  // 以前的小助手消息（已读）：让对话窗口有一点历史
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  repoNow.insert('assistant_messages', { id: 'seed-old-1', created_at: ago(20), skill_id: 'checkin_milestone', dedup_key: 'seed:checkin:14',
    month: g.monthNY(new Date(ago(20))), text: g.checkinMilestoneText(14), read_at: ago(20) });
  repoNow.insert('assistant_messages', { id: 'seed-old-2', created_at: ago(6), skill_id: 'pending_items', dedup_key: 'seed:pending',
    month: g.monthNY(new Date(ago(6))), text: '还有 1 笔金额没补全，补上后预算统计会更准哦', action: 'goto:pending', read_at: ago(6) });
  const cat = (name, type) => g.api_bootstrap().categories.find((c) => c.name === name && c.type === type && !c.archived).id;
  const add = (type, amount, category, day, time, merchant, extra) => g.api_saveEntry(Object.assign({
    id: null, type, amount, is_refund: false, refund_of: '', category_id: cat(category, type), income_source_id: '', new_source_name: '',
    local_datetime: m + '-' + day + 'T' + time, merchant: merchant || '', note: ''
  }, extra || {}));
  add('expense', '12.00', '餐饮', '02', '12:10', '午饭');
  add('expense', '4.50', '交通', '02', '08:30', '地铁');
  add('expense', '86.20', '购物', '02', '19:00', '超市');
  add('expense', '1200.00', '住房', '01', '09:00', '房租');
  add('expense', '23.90', '娱乐', '01', '21:00', '电影');
  add('income', '800.00', '兼职', '01', '10:00', '', { new_source_name: '兼职 A' });
  g.api_addCategory('expense', '健身房');   // 用户自建类别：没有专属图标，显示首字
  add('expense', '35.00', '健身房', '01', '15:00', '月卡');
  add('expense', '18.00', '宠物', '01', '14:00', '猫粮');
  const repo = g.sheetRepo_(backend.ss);

  // 报表 / 账单用的历史数据：本月之前 14 个月（跨两个自然年），每月工资 + 房租 + 若干日常支出
  const pick = (arr, i) => arr[i % arr.length];
  for (let back = 1; back <= 14; back++) {
    const mm = g.addMonths(m, -back);
    add('income', '3200.00', '工资', '01', '09:00', '', { local_datetime: mm + '-01T09:00' });
    add('expense', '1200.00', '住房', '01', '09:30', '房租', { local_datetime: mm + '-01T09:30' });
    add('expense', (180 + back * 7) + '.40', '餐饮', '01', '12:00', '餐厅', { local_datetime: mm + '-08T12:00' });
    add('expense', (60 + back * 3) + '.00', pick(['购物', '交通', '娱乐', '咖啡奶茶', '买菜', '服饰', '数码'], back), '01', '18:00', '', { local_datetime: mm + '-15T18:00' });
    add('expense', (25 + back) + '.50', pick(['水果', '零食', '通讯', '订阅会员', '书籍', '礼物', '运动', '医疗'], back), '01', '19:00', '', { local_datetime: mm + '-20T19:00' });
    if (back % 3 === 0) add('expense', '420.00', '旅行', '01', '10:00', '周末出游', { local_datetime: mm + '-22T10:00' });
    if (back === 2) add('income', '500.00', '奖金', '01', '10:00', '', { local_datetime: mm + '-25T10:00' });
  }
  // 上个月的一笔退款（冲减上月餐饮）
  const lastMonth = g.addMonths(m, -1);
  add('expense', '20.00', '餐饮', '01', '12:00', '餐厅退款', { local_datetime: lastMonth + '-12T12:00', is_refund: true });

  // 预算：3 个月前设了总预算和餐饮预算（之后每月沿用），上个月起总预算改为 1,800；本月几项类别预算分别处于正常 / 接近 / 超出
  const at = (month) => g.parseLocalNY(month + '-10T12:00');
  const bid = () => 'seed-' + Math.random().toString(36).slice(2);
  g.svcSetBudget(repo, 'total', '2000', at(g.addMonths(m, -3)), bid);
  g.svcSetBudget(repo, 'exp_dining', '250', at(g.addMonths(m, -3)), bid);
  g.svcSetBudget(repo, 'total', '1800', at(lastMonth), bid);
  g.api_setBudget('exp_shopping', '80');    // 已花 86.20 → 超出
  g.api_setBudget('exp_transport', '100');  // 4.50 → 正常
  g.api_setBudget('exp_dining', '14');      // 12.00 → 接近（86%）

  const d = g.parseLocalNY(m + '-02T10:00');
  repo.insert('entries', { id: 'preview-pending', type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: g.monthNY(d),
    date_ny: g.dateNY(d), category_id: 'exp_uncategorized', merchant: 'Apple Pay', channel: 'apple_pay',
    source_key: 'preview:1', created_at: d.toISOString(), updated_at: d.toISOString() });

  // 小助手：上个月的表扬按“完整数据”重新检查一次（预置数据是先记账后设预算的），然后运行一次规则
  repo.removeByKeys('assistant_state', ['last_month_praise:checked:' + lastMonth]);
  g.api_bootstrap();
  // 本月 7 日以前不会有超支速度提醒：预览里放一条示例，方便看样式
  if (!repo.list('assistant_messages').some((x) => x.skill_id === 'budget_pace')) {
    repo.insert('assistant_messages', { id: 'seed-pace', created_at: new Date().toISOString(), skill_id: 'budget_pace', dedup_key: 'seed:pace',
      month: m, text: '喵～本月每日平均预算 $58.06，目前日均支出 $96.11，照这个速度月底可能会超支哦（预览示例）',
      items_json: JSON.stringify([{ label: '每日平均预算', amount_cents: 5806 }, { label: '目前日均支出', amount_cents: 9611 }]) });
  }
}

// 浏览器里的假 google.script.run：把调用转给本进程的真实服务器函数
const STUB = `<script>
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('reduced') === '1') {
    window.matchMedia = function (s) { return { matches: /reduced-motion/.test(s), media: s, addListener: function () {}, removeListener: function () {} }; };
  }
  function call(fn, args, ok, bad) {
    var slow = document.getElementById('dev-slow') && document.getElementById('dev-slow').checked;
    var failNext = document.getElementById('dev-fail') && document.getElementById('dev-fail').checked;
    var wait = (fn === 'api_saveEntry' && slow) ? 2000 : 0;
    setTimeout(function () {
      if (fn === 'api_saveEntry' && failNext) { bad && bad(new Error('没保存成功，再试一次')); return; }
      fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args }) })
        .then(function (r) { return r.json(); })
        .then(function (r) { if (r.error) { bad && bad(new Error(r.error)); } else { ok && ok(r.result); } });
    }, wait);
  }
  function runner(ok, bad) {
    return new Proxy({}, { get: function (_, prop) {
      if (prop === 'withSuccessHandler') return function (f) { return runner(f, bad); };
      if (prop === 'withFailureHandler') return function (f) { return runner(ok, f); };
      return function () { call(prop, Array.prototype.slice.call(arguments), ok, bad); };
    } });
  }
  window.google = { script: { run: runner(null, null) } };
})();
</script>`;
const STRIP = `<div style="background:#fff3cd;color:#664d03;font:13px/1.4 sans-serif;padding:6px 10px;display:flex;gap:14px;flex-wrap:wrap;align-items:center">
  <b>预览模式</b>
  <label><input type="checkbox" id="dev-fail"> 下次保存失败</label>
  <label><input type="checkbox" id="dev-slow"> 慢网络（保存多等 2 秒）</label>
</div>`;

seed();
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/rpc') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { fn, args } = JSON.parse(body);
        if (typeof g[fn] !== 'function' || fn.endsWith('_')) throw new Error('Script function not found: ' + fn);
        const result = g[fn](...args);
        res.end(JSON.stringify({ result: result === undefined ? null : result }));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url.split('?')[0] === '/') {
    const html = backend.html().replace('</head>', STUB + '</head>').replace('<body>', '<body>' + STRIP);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }
  res.statusCode = 404; res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log('预览已启动：http://localhost:' + PORT + '  （Ctrl+C 退出）'));
