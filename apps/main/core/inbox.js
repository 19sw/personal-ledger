/**
 * Apple Pay 收件箱整理规则（spec 4.3、4.4、5.1 第 4 步、5.3），纯函数，不读写表格。
 * 读写在 applepay.js（通过 repo 接口）和 store.js（真正的「收件箱」表格）。
 *
 * 「收件箱」里的每一行都是项目 I 写下的“未经核实的文字”：金额、商家、时间都可能为空或乱写，
 * 所以这里只做保守的解析——认不出的金额就留空（待补全），认不出的时间就用服务器收到的时间。
 */

/** 与 apps/inbox/core.js 的 INBOX_COLUMNS 相同（两个项目不能共享文件；测试会检查两者一致）。 */
var INBOX_COLUMNS = ['row_type', 'received_at', 'event_id', 'amount_text', 'merchant_text', 'occurred_at_text',
  'shortcut_version', 'rejected_count'];
var INBOX_SHEET_NAME = 'inbox';

var APPLE_PAY_KEY_PREFIX = 'applepay:evt:';
var APPLE_PAY_DEFAULT_MERCHANT = 'Apple Pay';
var INBOX_KEEP_DAYS = 30;          // 收件箱原始行保留 30 天（spec 4.3）
var INBOX_STALE_DAYS = 7;          // 超过 7 天仍未整理 → 报警
var RATE_WARN_DAYS = 7;            // 限流标记在首页提示 7 天
var DUP_WINDOW_MS = 24 * 3600000;  // 跨渠道疑似重复：时间相差 ≤ 24 小时
/** 快捷指令的时间与服务器收到时间相差太多时不采用（防止乱写的时间把账目放进很早或未来的月份）。 */
var SHORTCUT_TIME_MAX_EARLY_MS = 24 * 3600000;
var SHORTCUT_TIME_MAX_LATE_MS = 10 * 60000;

function applePaySourceKey(eventId) {
  return APPLE_PAY_KEY_PREFIX + eventId;
}

/**
 * 金额文字 → 整数美分。接受 '$12.34'、'12.34'、'US$1,234.00'（parseUsdToCents 的写法）；
 * 空、乱码、负数、0 → null（账目为“待补全”）。
 */
function parseApplePayAmount(text) {
  var s = String(text === null || text === undefined ? '' : text).trim();
  if (s === '' || /^[-−(]/.test(s)) return null;
  var cents = parseUsdToCents(s);
  return cents !== null && cents > 0 ? cents : null;
}

/**
 * 交易时间：快捷指令发来的带时区偏移的 ISO 时间（如 2026-01-31T23:30:00-05:00，或以 Z 结尾）。
 * 认不出、没有时区、或与服务器收到的时间相差太多（早于 24 小时前 / 晚于 10 分钟后）时，使用 received_at。
 * 返回 Date。
 */
function applePayOccurredAt(occurredText, receivedAtIso) {
  var received = new Date(receivedAtIso);
  var s = String(occurredText === null || occurredText === undefined ? '' : occurredText).trim();
  var m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (!m) return received;
  var iso = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/\.(\d{3})\d+/, '.$1');
  var t = Date.parse(iso);
  if (isNaN(t)) return received;
  var r = received.getTime();
  if (t < r - SHORTCUT_TIME_MAX_EARLY_MS || t > r + SHORTCUT_TIME_MAX_LATE_MS) return received;
  return new Date(t);
}

/** 商家：去掉首尾空白，截断到 200 字；空 → 'Apple Pay'。 */
function applePayMerchant(text) {
  var s = String(text === null || text === undefined ? '' : text).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s || APPLE_PAY_DEFAULT_MERCHANT;
}

/** 由收件箱的一行生成一笔 Apple Pay 支出（类别“未分类”，channel = apple_pay，PRD 6.1）。 */
function buildApplePayEntry(row, categoryId, id, now) {
  var occurred = applePayOccurredAt(row.occurred_at_text, row.received_at);
  var ts = now.toISOString();
  return {
    id: id, type: 'expense', amount_cents: parseApplePayAmount(row.amount_text),
    occurred_at: occurred.toISOString(), month_ny: monthNY(occurred), date_ny: dateNY(occurred),
    category_id: categoryId, income_source_id: null, merchant: applePayMerchant(row.merchant_text), note: '',
    channel: 'apple_pay', platform: null, is_refund: false, refund_of: null, flag_dup: false, dup_group: null,
    flag_amount_review: false, source_key: applePaySourceKey(row.event_id), order_ref: null,
    created_at: ts, updated_at: ts, deleted_at: null
  };
}

// ---------------- 跨渠道疑似重复（spec 4.4） ----------------

/** 商家规范化：NFKC → 小写 → 只保留字母和数字（中文保留）。 */
function merchantKey(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 用于比较的商家：Apple Pay 拿不到商家时显示的默认名“Apple Pay”视为空。 */
function dupMerchantKey_(e) {
  if (e.channel === 'apple_pay' && e.merchant === APPLE_PAY_DEFAULT_MERCHANT) return '';
  return merchantKey(e.merchant);
}

/** 商家相近：任一方为空，或规范化后一方包含另一方。 */
function merchantsSimilar(a, b) {
  if (!a || !b) return true;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

/**
 * 外卖平台的别名（spec 4.4）：一方是某个平台的外卖收据自动记录，另一方的商家（规范化后）包含该平台的某个别名，
 * 也算商家相近，例如 Apple Pay 与平台收据显示不同但相近的商家名。两个方向都检查。
 */
function platformAliasMatch_(gmailEntry, otherKey) {
  if (!gmailEntry || gmailEntry.channel !== 'gmail_receipt' || !gmailEntry.platform || !otherKey) return false;
  if (typeof receiptPlatformAliasKeys !== 'function') return false;
  return receiptPlatformAliasKeys(gmailEntry.platform).some(function (k) { return otherKey.indexOf(k) >= 0; });
}

function entriesMerchantSimilar_(a, b) {
  var ka = dupMerchantKey_(a), kb = dupMerchantKey_(b);
  return merchantsSimilar(ka, kb) || platformAliasMatch_(a, kb) || platformAliasMatch_(b, ka);
}

/** “两笔都保留”记录的键：两个账目 id 排序后用 | 连接。 */
function dupPairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

/**
 * 找出与 entry 疑似同一笔的其他账目：未删除、金额相同且非空、时间相差 ≤ 24 小时、商家相近（含外卖平台别名）、渠道不同、
 * 且这一对没有被你选过“两笔都保留”（dup_dismissed）。
 */
function findDupCandidates(entry, entries, dismissedRows) {
  if (entry.amount_cents === null || entry.amount_cents === undefined || !isLive(entry)) return [];
  var dismissed = {};
  (dismissedRows || []).forEach(function (r) { dismissed[r.pair_key] = true; });
  var t = new Date(entry.occurred_at).getTime();
  return entries.filter(function (o) {
    if (o.id === entry.id || !isLive(o) || o.channel === entry.channel) return false;
    if (o.amount_cents === null || o.amount_cents === undefined || o.amount_cents !== entry.amount_cents) return false;
    if (o.type !== entry.type) return false;
    var ot = new Date(o.occurred_at).getTime();
    if (isNaN(ot) || isNaN(t) || Math.abs(ot - t) > DUP_WINDOW_MS) return false;
    if (!entriesMerchantSimilar_(entry, o)) return false;
    return !dismissed[dupPairKey(entry.id, o.id)];
  });
}

// ---------------- 收件箱的行 ----------------

function inboxTimeMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v === null || v === undefined) return NaN;
  return Date.parse(String(v));
}

/** 交易行中还没有整理过的（凭据不在 processed_sources 中）。 */
function unprocessedInboxRows(rows, processedKeys) {
  return rows.filter(function (r) {
    return r.row_type === 'txn' && r.event_id && !processedKeys[applePaySourceKey(r.event_id)];
  });
}

/** 超过 7 天仍未整理的交易行数（spec 4.3 报警）。 */
function countStaleInboxRows(rows, processedKeys, now) {
  var limit = now.getTime() - INBOX_STALE_DAYS * DAY_MS;
  return rows.filter(function (r) {
    if (r.row_type !== 'txn') return false;
    if (r.event_id && processedKeys[applePaySourceKey(r.event_id)]) return false;
    var t = inboxTimeMs_(r.received_at);
    return !isNaN(t) && t < limit;
  }).length;
}

/** 每日清理：received_at 早于 30 天前的行（交易行和标记行都算）。时间认不出的行不删（宁可多留）。返回行号。 */
function selectInboxPurgeRows(rows, now) {
  var limit = now.getTime() - INBOX_KEEP_DAYS * DAY_MS;
  return rows.filter(function (r) {
    var t = inboxTimeMs_(r.received_at);
    return !isNaN(t) && t < limit;
  }).map(function (r) { return r.row_index; });
}

/** 限流标记行 → [{marker_at, rejected_count}]（marker_at 为 ISO 时间）。 */
function inboxRateMarkers(rows) {
  var out = [];
  rows.forEach(function (r) {
    if (r.row_type !== 'rate_limited') return;
    var t = inboxTimeMs_(r.received_at);
    if (isNaN(t)) return;
    var n = Number(r.rejected_count);
    out.push({ marker_at: new Date(t).toISOString(), rejected_count: isFinite(n) && n > 0 ? Math.floor(n) : 1 });
  });
  return out;
}

/** '2026-10-15T18:05:00Z' → '10 月 15 日 14:05'（费城时间） */
function markerLabel(iso) {
  var p = nyParts(iso);
  return p.mo + ' 月 ' + p.d + ' 日 ' + pad2_(p.h) + ':' + pad2_(p.mi);
}

/** 小助手和首页共用的限流文字（spec 5.3、7A.3）。 */
function rateLimitedText(markerAt, count) {
  return 'Apple Pay 收件口在 ' + markerLabel(markerAt) + ' 起拒收了 ' + count + ' 笔付款（超出每小时 10 笔或每天 30 笔的上限），' +
    '请对照付款记录手动补记';
}
