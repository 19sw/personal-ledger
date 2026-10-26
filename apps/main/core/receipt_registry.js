/**
 * 外卖平台注册表（spec 6.5）。每个平台是 core/platforms/ 下的一个规则文件；以后加平台：
 *   1. 新建 core/platforms/<平台>.js（照着已有的写，定义 RECEIPT_PLATFORM_<平台>）；
 *   2. 在下面 receiptPlatforms() 的清单里加一项；
 *   3. 补上合成测试样本，做一次 G1/G2。
 * 共用流程（receipt_pipeline.js）不用改。
 *
 * 用函数返回清单（而不是在文件加载时就建好），是因为 Apps Script 加载文件的先后顺序不固定。
 */
function receiptPlatforms() {
  return [RECEIPT_PLATFORM_DOORDASH, RECEIPT_PLATFORM_UBER, RECEIPT_PLATFORM_UBEREATS];
}

var RECEIPT_SUPPORT_LABEL = { unverified: '未验证', supported: '已支持', partial: '部分支持', unsupported: '未支持' };

var RECEIPT_SEARCH_WINDOW = 'newer_than:3d';   // spec 6.4：3 天的重叠窗口，中断时不漏信

function findReceiptPlatform(platforms, id) {
  return (platforms || []).filter(function (p) { return p.id === id; })[0] || null;
}

/** 这个平台现在是否参与自动记账（spec 6.5 第 2 步；未支持的平台视为关闭）。 */
function receiptPlatformActive(p) {
  return !!p && p.enabled !== false && p.support_status !== 'unsupported';
}

/** 一个平台自己的搜索条件：{from:(a) from:(b)}（dryRunReceipts 用）。 */
function platformQuery(p) {
  return '{' + (p.gmailQuery || []).join(' ') + '}';
}

/**
 * 合并搜索（spec 6.4 第 2 步）：所有参与记账的平台的条件放进同一个 {…}（Gmail 搜索中表示“任一”），加上 3 天窗口。
 * 没有参与记账的平台时返回 null（不搜索）。
 */
function senderDomain_(frag) {
  var m = /from:\(([^)]+)\)/i.exec(String(frag || ''));
  return m ? m[1].toLowerCase() : '';
}

function buildReceiptQuery(platforms, senderRows) {
  var frags = [];
  (platforms || []).filter(receiptPlatformActive).forEach(function (p) {
    (p.gmailQuery || []).forEach(function (frag) { if (frags.indexOf(frag) < 0) frags.push(frag); });
  });
  (senderRows || []).filter(function (s) { return s.mode === 'auto'; }).forEach(function (s) {
    if (s.domain && frags.indexOf('from:(' + s.domain + ')') < 0) frags.push('from:(' + s.domain + ')');
  });
  var builtins = [];
  (platforms || []).forEach(function (p) { (p.gmailQuery || []).forEach(function (f) {
    var d = senderDomain_(f); if (d && builtins.indexOf(d) < 0) builtins.push(d);
  }); });
  var excluded = builtins.concat((senderRows || []).map(function (s) { return s.domain; }).filter(Boolean));
  excluded = excluded.filter(function (d, i, a) { return a.indexOf(d) === i; });
  var muted = (senderRows || []).filter(function (s) { return s.mode === 'muted'; }).map(function (s) { return s.domain; }).filter(Boolean);
  muted = muted.filter(function (d, i, a) { return a.indexOf(d) === i; });
  var globalMute = muted.map(function (d) { return '-from:(' + d + ')'; }).join(' ');
  var branches = [];
  if (globalMute && frags.length) branches.push('{' + frags.join(' ') + '} ' + globalMute);
  else if (globalMute) { /* broad branch below also excludes muted domains */ }
  var broad = GMAIL_BROAD_QUERY.slice(RECEIPT_SEARCH_WINDOW.length + 1);
  if (excluded.length) broad = '(' + broad + ' ' + excluded.map(function (d) { return '-from:(' + d + ')'; }).join(' ') + ')';
  if (!globalMute && frags.length) branches.push('{' + frags.join(' ') + '}');
  branches.push(broad);
  return RECEIPT_SEARCH_WINDOW + ' (' + branches.join(' OR ') + ')';
}

/** 平台 id → 规范化后的别名（跨渠道疑似重复用，spec 4.4）。找不到平台时为空数组。 */
function receiptPlatformAliasKeys(platformId, platforms) {
  var p = findReceiptPlatform(platforms || receiptPlatforms(), platformId);
  if (!p) return [];
  return (p.merchantAliases || []).concat([p.displayName]).map(merchantKey).filter(function (k) { return k.length >= 2; });
}

/** 平台显示名（未知平台显示 id 本身）。 */
function receiptPlatformName(platformId, platforms) {
  var p = findReceiptPlatform(platforms || receiptPlatforms(), platformId);
  return p ? p.displayName : String(platformId || '');
}
