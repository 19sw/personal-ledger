/**
 * 外卖收据的文字处理工具（spec 6.5 第 1 步与“通用的总额规则”），纯函数，Apps Script 和 Node 测试都能运行。
 *
 * 隐私：这里处理的邮件正文、主题只在一次运行的内存里使用，这些函数既不保存也不打印它们（spec 6.3）。
 * 各平台的规则文件（core/platforms/*.js）调用这里的辅助函数；以后加平台只需写规则，不用改这里。
 */

var RECEIPT_MAX_BODY_CHARS = 1500000;  // 单封邮件正文最多处理的字符数（防止异常大的邮件拖慢运行；收据 HTML 常含大段内联样式，留足余量）

// ---------------- HTML → 纯文本 ----------------

var HTML_ENTITIES_ = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", yen: '¥', pound: '£', euro: '€',
  cent: '¢', dollar: '$', colon: ':', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '', middot: '·',
  ndash: '–', mdash: '—', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '…', times: '×', num: '#'
};

function decodeHtmlEntities_(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, function (m, name) {
    if (name.charAt(0) === '#') {
      var code = name.charAt(1) === 'x' || name.charAt(1) === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return '';
      try { return String.fromCodePoint(code); } catch (e) { return ''; }
    }
    var v = HTML_ENTITIES_[name.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * HTML → 纯文本。表格的一行（tr）、段落、换行等变成换行；同一行里的单元格（td/th）之间用空格隔开，
 * 这样“Total | $23.45”这样的两格会留在同一行，便于按标签找金额。
 */
function htmlToText(html) {
  var s = String(html || '');
  if (s.length > RECEIPT_MAX_BODY_CHARS) s = s.slice(0, RECEIPT_MAX_BODY_CHARS);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|ul|ol|h[1-6]|table|tbody|thead|tfoot|section|article|header|footer|center|blockquote|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return normalizeReceiptText(decodeHtmlEntities_(s));
}

/**
 * 纯文本规范化：NFKC（全角数字、全角冒号、全角 $ 变成半角）、去掉零宽字符、每行合并空白、去掉空行。
 * 返回用 \n 连接的文本。
 */
function normalizeReceiptText(text) {
  var s = String(text || '');
  if (s.length > RECEIPT_MAX_BODY_CHARS) s = s.slice(0, RECEIPT_MAX_BODY_CHARS);
  s = s.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '').replace(/\r\n?/g, '\n');
  return s.split('\n').map(function (line) { return line.replace(/[ \t\f\v 　]+/g, ' ').trim(); })
    .filter(function (line) { return line !== ''; }).join('\n');
}

function receiptLines(text) {
  return String(text || '') === '' ? [] : String(text).split('\n');
}

/** HTML 中的链接地址（只给订单标识用；不保存）。 */
function extractHtmlLinks(html) {
  var out = [];
  var re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
  var m;
  var s = String(html || '');
  if (s.length > RECEIPT_MAX_BODY_CHARS) s = s.slice(0, RECEIPT_MAX_BODY_CHARS);
  while ((m = re.exec(s)) !== null && out.length < 500) out.push(decodeHtmlEntities_(m[2] !== undefined ? m[2] : m[3]));
  return out;
}

// ---------------- 发件人 ----------------

/**
 * From 邮件头 → {name, domain}：显示名（例如“Uber Eats”）和发件域名（小写）。
 * 只在内存里用于判断平台；不保存完整地址（spec 6.3）。
 */
function parseFromHeader(from) {
  var s = String(from || '').normalize('NFKC').trim();
  var addr = s, name = '';
  var m = /^(.*)<([^<>]*)>\s*$/.exec(s);
  if (m) { name = m[1].trim().replace(/^"(.*)"$/, '$1').trim(); addr = m[2].trim(); }
  var at = addr.lastIndexOf('@');
  var domain = at >= 0 ? addr.slice(at + 1).toLowerCase().replace(/[^a-z0-9.-]/g, '') : '';
  return { name: name, domain: domain };
}

/** 发件域名是否属于这些域名（完全相同，或是它的子域名，例如 mail.doordash.com）。 */
function senderDomainIn(from, domains) {
  var d = from && from.domain ? from.domain : '';
  if (!d) return false;
  return (domains || []).some(function (x) { return d === x || d.slice(-(x.length + 1)) === '.' + x; });
}

// ---------------- 金额 ----------------

/** 认作美元的写法；其他币种写法会让金额为空（CURRENCY_UNKNOWN），不做汇率换算（spec 6.5）。 */
var USD_MARKERS_ = { '$': true, 'US$': true, 'USD': true };
var OTHER_CURRENCY_CODES_ = 'CAD|AUD|NZD|HKD|SGD|CNY|RMB|EUR|GBP|JPY|KRW|TWD|MXN|INR|CHF';

/**
 * 一行里的金额（按出现顺序）：[{cents, currency, negative}]。currency 为 '$'/'US$'/'USD' 表示美元，
 * 其他（'CA$'、'¥'、'CAD'、'元' 等）表示非美元，null 表示没有币种标记（不当作金额，见 extractLabeledAmount）。
 */
function moneyTokens(line) {
  var s = String(line || '');
  var re = new RegExp(
    '(-|−)?\\s*(US\\$|[A-Z]{1,3}\\$|\\$|¥|€|£|₩|₹|(?:USD|' + OTHER_CURRENCY_CODES_ + ')(?=\\s?\\d))?\\s?(-|−)?\\s?' +
    '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(?!\\d|,\\d|\\.\\d)\\s?(USD|' + OTHER_CURRENCY_CODES_ + '|元|円)?', 'g');
  var out = [];
  var m;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    var prev = m.index > 0 ? s.charAt(m.index - 1) : '';
    if (/[A-Za-z0-9.]/.test(prev) && !m[1] && !m[2]) continue;   // 例如订单号 ABC123 里的数字
    var currency = m[2] || m[6] || null;
    var whole = m[4].replace(/,/g, '');
    if (whole.length > 9) continue;
    var cents = Number(whole) * 100 + Number(((m[5] || '') + '00').slice(0, 2));
    out.push({ cents: cents, currency: currency, negative: !!(m[1] || m[3]) });
  }
  return out;
}

function isUsdMarker_(c) {
  return !!USD_MARKERS_[c];
}

/** 标签比较用：NFKC + 小写 + 合并空白。 */
function labelKey_(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 一行是否以这个标签开头，并且标签后面到第一个金额之间只有标点、空格或括号里的说明
 * （“Total: $23.45”“Total (incl. tax) $23.45”可以；“Total savings $3.00”“Subtotal $20.00”不行）。
 * line 必须已经过 normalizeReceiptText。返回标签之后的原文（用来找金额），不匹配返回 null。
 */
var MONEY_START_RE_ = new RegExp('(?:-|−)?\\s?(?:us\\$|[a-z]{1,3}\\$|\\$|¥|€|£|₩|₹|(?:usd|' + OTHER_CURRENCY_CODES_.toLowerCase() + ')(?=\\s?\\d))?\\s?\\d');

function lineAfterLabel_(line, label, allLabels) {
  var k = labelKey_(label);
  if (!k || line.slice(0, k.length).toLowerCase() !== k) return null;
  var rest = line.slice(k.length);
  var plain = rest.toLowerCase().replace(/\([^)]*\)/g, ' ');
  var m = MONEY_START_RE_.exec(plain);
  var before = m ? plain.slice(0, m.index) : plain;
  // 中英双语标签（“总计 Total：$25.50”）：标签后面紧跟的另一个标签不算“别的词”
  (allLabels || []).forEach(function (other) { before = before.split(labelKey_(other)).join(' '); });
  if (/[\p{L}]/u.test(before)) return null;
  return rest;
}

/** 下一行只允许单独一个金额，不能把“Fare $21”或“小计 $21”当成上一行的总额。 */
function standaloneMoneyTokens_(line) {
  var remainder = String(line || '').replace(new RegExp('US\\$|[A-Z]{1,3}\\$|USD|' + OTHER_CURRENCY_CODES_ + '|元|円', 'g'), '');
  if (!/^[\s\d.,$¥€£₩₹−-]+$/.test(remainder)) return [];
  var tokens = moneyTokens(line);
  return tokens.length === 1 ? tokens : [];
}

/**
 * 按标签找金额（spec 6.5 通用总额规则）：
 *  - 只看以 labels 中某个标签开头的行，exclude（例如 Subtotal、小计）开头的行一律跳过；
 *  - 标签行本身没有金额时，看紧接着的下一行是否只有一个金额；
 *  - 只接受美元写法；出现别的币种 → {cents: null, reason: 'CURRENCY_UNKNOWN'}；
 *  - 一个也没有 → 'TOTAL_NOT_FOUND'；多个不同的金额 → 'MULTIPLE_TOTALS'（由处理流程保留为待查看邮件或关联既有账目核对）。
 * opts.bareIsUsd：没有币种标记的数字也当作美元（默认否）。
 * 返回 {cents, reason, label, currency}。label 是规则里的标签（不是邮件原文）。
 */
function extractLabeledAmount(text, labels, exclude, opts) {
  opts = opts || {};
  var lines = receiptLines(normalizeReceiptText(text));
  var sorted = (labels || []).slice().sort(function (a, b) { return b.length - a.length; });
  var excl = (exclude || []).map(labelKey_);
  var found = [];
  var other = null, otherLabel = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (opts.finalTotal && (textHas(line, RECEIPT_PROMO_TEXT_) || /\b(?:discount|savings)\b|满减|优惠|折扣/i.test(line) || (i + 1 < lines.length && /^(?:minimum\s+(?:spend|order)|or more\b|起送|可享)/i.test(lines[i + 1])))) continue;
    var lk = labelKey_(line);
    if (excl.some(function (x) { return lk.slice(0, x.length) === x; })) continue;
    for (var j = 0; j < sorted.length; j++) {
      var rest = lineAfterLabel_(line, sorted[j], sorted);
      if (rest === null) continue;
      var toks = moneyTokens(rest);
      var amountLine = i;
      if (!toks.length && i + 1 < lines.length) {
        toks = standaloneMoneyTokens_(lines[i + 1]);
        if (toks.length) amountLine = i + 1;
      }
      // Context follows the consumed amount, including when HTML split it below the label.
      if (opts.finalTotal && amountLine + 1 < lines.length && /^(?:minimum\s+(?:spend|order)|or more\b|起送|可享)/i.test(lines[amountLine + 1])) break;
      if (opts.finalTotal && toks.some(function (t) { return t.negative; })) return { cents: null, reason: 'TOTAL_NOT_FOUND', label: sorted[j], currency: null };
      toks.forEach(function (t) {
        if (t.currency === null && !opts.bareIsUsd) return;
        if (t.currency !== null && !isUsdMarker_(t.currency)) { other = other || t.currency; otherLabel = otherLabel || sorted[j]; return; }
        found.push({ cents: t.cents, label: sorted[j] });
      });
      break;
    }
  }
  if (other !== null) return { cents: null, reason: 'CURRENCY_UNKNOWN', label: otherLabel, currency: other };
  if (!found.length) return { cents: null, reason: 'TOTAL_NOT_FOUND', label: null, currency: null };
  var distinct = {};
  found.forEach(function (f) { distinct[f.cents] = true; });
  if (Object.keys(distinct).length > 1) return { cents: null, reason: 'MULTIPLE_TOTALS', label: found[0].label, currency: 'USD' };
  return { cents: found[0].cents, reason: null, label: found[0].label, currency: 'USD' };
}

/** 文本里是否有以这些标签开头、并带美元或其他币种金额的行（给“uncertain：看起来有金额”用）。 */
function hasLabeledMoney(text, labels) {
  var lines = receiptLines(normalizeReceiptText(text));
  return lines.some(function (line, i) {
    return (labels || []).some(function (lb) {
      var rest = lineAfterLabel_(line, lb, labels);
      if (rest === null) return false;
      var toks = moneyTokens(rest).concat(i + 1 < lines.length ? moneyTokens(lines[i + 1]) : []);
      return toks.some(function (t) { return t.currency !== null; });
    });
  });
}

// Bounded labels and evidence; names and greetings never decide whether money was spent.
var RECEIPT_PROMO_TEXT_ = /minimum\s+(?:spend|order)|\bpromo|\boffers?\b|free delivery|orders?\s+(?:over|above)|\bor more\b|\bsave\s+[$£€]|\d+\s*%\s*off|next\s+(?:(?:uber(?: eats)?)\s+)?(?:order|ride)|满.{0,18}减|起送|可享|优惠码|下次.*(?:优惠|折扣)/i;
var RECEIPT_UNPAID_ = /\b(?:unpaid|payment pending|awaiting payment|amount due|payment due|pay now)\b|待付款|待支付|未付款|未支付|尚未支付/i;
var RECEIPT_PROSPECTIVE_ = /\b(?:fare|ride|trip|price) estimate\b|\bestimated (?:fare|total|price|cost)\b|\bupcoming (?:ride|trip|order)\b|(?:行程|车费|费用|总额).{0,4}(?:预估|估算)|(?:预估|估算).{0,4}(?:行程|车费|费用|总额)|报价/i;
var RECEIPT_PAID_SUBJECT_ = /\bpayment (?:received|successful|completed|confirmation)\b|已付款|已支付|支付成功|付款成功/i;
function hasPaymentEvidence_(subject, text) {
  if (textHas(subject, RECEIPT_PAID_SUBJECT_)) return true;
  return receiptLines(text).some(function (line) {
    return /^(?:payment (?:received|successful|completed)|paid successfully|trip completed|ride completed|(?:订单)?(?:已支付|已付款)|支付成功|付款成功|行程已完成)(?:\b|[，,:：!！。\s]|$)/i.test(line);
  });
}
/**
 * 试运行用：一封判为 uncertain 的邮件是被哪条规则拦下的。只返回规则代码和命中的规则词（来自上面固定的词表，
 * 最多 24 个字），不返回邮件里的其他文字。
 */
function receiptUncertainWhy_(subject, text) {
  var all = subject + '\n' + text;
  var m = RECEIPT_UNPAID_.exec(all);
  if (m) return 'UNPAID_WORD:' + m[0].toLowerCase().slice(0, 24);
  m = RECEIPT_PROSPECTIVE_.exec(all);
  if (m) return 'ESTIMATE_WORD:' + m[0].toLowerCase().slice(0, 24);
  return 'NO_RECEIPT_EVIDENCE';
}

/**
 * 正文里唯一的“不确定”说法是 “estimated total”（去掉这几个词后没有其他未付款或预估说法）。
 * 只给明确的订单确认邮件用（DoorDash：下单后小费还能改，确认邮件写的是预估总额）。
 */
function onlyEstimatedTotal_(subject, text) {
  var all = subject + '\n' + text;
  if (!/\bestimated total\b/i.test(all)) return false;
  var rest = all.replace(/\bestimated total\b/ig, ' ');
  return !textHas(rest, RECEIPT_UNPAID_) && !textHas(rest, RECEIPT_PROSPECTIVE_);
}

function receiptEvidenceKind_(subject, text, explicit, labels) {
  if (textHas(subject + '\n' + text, RECEIPT_UNPAID_) || textHas(subject + '\n' + text, RECEIPT_PROSPECTIVE_)) return 'uncertain';
  if (explicit || hasPaymentEvidence_(subject, text)) return 'receipt';
  if (textHas(subject + '\n' + text, RECEIPT_PROMO_TEXT_)) return 'other';
  return hasLabeledMoney(text, labels) ? 'uncertain' : 'other';
}

// ---------------- 订单标识 ----------------

/**
 * 订单标识：先在链接里找（linkPatterns，第 1 个捕获组），再在正文里找（textPatterns）。
 * 只接受 4–64 个字母、数字或 -（避免把一句话当成编号）。找不到返回 null。
 */
function findOrderRef(text, links, linkPatterns, textPatterns) {
  function ok(v) {
    var s = String(v || '').trim();
    return /^[A-Za-z0-9-]{4,64}$/.test(s) && /\d/.test(s) ? s : null;
  }
  function first(re, s) {
    var g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
    var mm;
    while ((mm = g.exec(s)) !== null) {
      if (ok(mm[1])) return ok(mm[1]);
      g.lastIndex = mm.index + 1;   // 例如“订单号 Order No.: HP123”：第一次捕获到 Order，从下一个字符接着找
    }
    return null;
  }
  var i, v;
  for (i = 0; i < (linkPatterns || []).length; i++) {
    for (var j = 0; j < (links || []).length; j++) {
      v = first(linkPatterns[i], String(links[j]));
      if (v) return v;
    }
  }
  for (i = 0; i < (textPatterns || []).length; i++) {
    v = first(textPatterns[i], String(text || ''));
    if (v) return v;
  }
  return null;
}

/** 关键词检查（不区分大小写，NFKC 之后）。 */
function textHas(s, re) {
  return re.test(String(s || '').normalize('NFKC'));
}

// ---------------- 分类 ----------------

/**
 * 按主题分类的通用规则（各平台的 classify 可以直接用，也可以自己写）。cfg：
 *   never   会员费、礼品卡等（不是外卖消费）
 *   refund  退款主题 → refund
 *   promo   促销主题
 *   receipt 收据主题 → receipt（新收据只有读到唯一实付金额才自动入账，否则待查看）
 *   amountLabels 以上都不是、但正文有带金额的总额/退款标签 → uncertain（D16：不入账，列入“待查看邮件”）
 * 退款或收据主题**同时**命中 never / promo（例如“Order Confirmation for Big Deal Burgers”）→ uncertain：
 * 不能确定，就列入“待查看邮件”，而不是悄悄忽略一笔可能真实的消费。只命中 never / promo → other。
 */
function classifyBySubject(subject, text, cfg) {
  var noise = (cfg.never || []).some(function (re) { return textHas(subject, re); }) || !!(cfg.promo && textHas(subject, cfg.promo)) || textHas(subject, RECEIPT_PROMO_TEXT_);
  if (cfg.refund && textHas(subject, cfg.refund)) return noise ? 'uncertain' : 'refund';
  var explicit = !!(cfg.receipt && textHas(subject, cfg.receipt)) || textHas(subject, RECEIPT_PAID_SUBJECT_);
  if (explicit && noise) return 'uncertain';
  if (noise) return 'other';
  return receiptEvidenceKind_(subject, text, explicit, cfg.amountLabels);
}
