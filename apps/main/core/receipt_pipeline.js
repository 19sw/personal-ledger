/**
 * 外卖收据的共用处理流程（spec 4.2、4.4、6.3–6.8），三个平台（以及以后新增的平台）共用。
 * 与 service.js / applepay.js 一样只通过 repo 接口读写「账本」；Gmail 由调用方以 client 对象注入
 * （正式运行时是 gmail.js 里的高级 Gmail 服务，测试时是假的），所以整条流程都能在 Node 中测试。
 * 调用方负责脚本锁。
 *
 * 隐私（spec 6.3）：邮件正文、主题、发件地址只在本次运行的内存里使用；保存的只有邮件编号、到达时间、
 * 订单标识、金额和分类结果。日志只写数量和结果代码。
 */

var GMAIL_KEY_PREFIX = 'gmail:msg:';
var GMAIL_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
var GMAIL_PAGE_SIZE = 50;
var GMAIL_MAX_PAGES = 20;                 // 3 天窗口最多翻 20 页（1000 封）；正常只有 1 页
var GMAIL_DRY_RUN_COUNT = 10;             // G1：每个平台最近 10 封
var READ_VOLUME_LIMIT = 30;               // 每轮最多读取 30 封 → READ_VOLUME_HIGH（spec 6.4）
var GMAIL_HEARTBEAT_MS = 20 * 60000;      // 开启后超过 20 分钟没有运行 → 提示可能已停止（spec 6.7）
var GMAIL_ISSUE_SHOW_DAYS = 7;            // 平台的“最近一次问题”显示 7 天
var D7_WINDOW_MS = 6 * 3600000;           // D7：同一家 DoorDash 餐厅 6 小时内的重复收据
var REFUND_DUP_WINDOW_MS = 24 * 3600000;  // 同一订单、同金额、1 天内的两封退款邮件
var ORDER_TIME_MAX_EARLY_MS = 3 * 24 * 3600000;
var GMAIL_TABLES = ['processed_sources', 'channel_status', 'gmail_pending', 'mail_senders'];
var GMAIL_BROAD_QUERY = 'newer_than:3d {category:purchases subject:receipt subject:invoice subject:payment subject:收据 subject:订单 subject:order subject:confirmation}';
var POLL_TIME_BUDGET_MS = 4 * 60000;      // 每轮最多处理约 4 分钟（远低于 6 分钟上限，也缩短持锁时间）；没处理完的下一轮接着处理

/** 错误代码的说明（只写类型，不写任何邮件内容）。svcRecordChannelRun_ 也会查这里。 */
var RECEIPT_ERROR_TEXT = {
  AUTH_REVOKED: 'Gmail 授权失效或被撤销（如需继续，请在脚本编辑器里运行一次 enableReceiptPolling 并按提示授权）',
  QUOTA_EXCEEDED: 'Gmail 读取额度暂时用完，之后会自动再试',
  GMAIL_FAILED: '读取 Gmail 时出错，下次会再试',
  GMAIL_SERVICE_MISSING: '没有启用高级 Gmail 服务（请按设置说明重新上传代码）',
  SETUP_REQUIRED: '需要先在脚本编辑器里重新运行一次 setupLedger',
  READ_VOLUME_HIGH: '这一轮达到 30 封读取上限，剩余邮件将在下一轮继续',
  TOO_MANY_PAGES: '3 天内的平台邮件太多，超过了每轮翻页上限，可能有邮件没读到',
  MESSAGE_FAILED: '有邮件处理失败，下次会再试',
  NO_CATEGORY: '找不到“餐饮”或“未分类”类别（请重新运行 setupLedger）',
  TOTAL_NOT_FOUND: '没找到实付总额，需要手动核对',
  MULTIPLE_TOTALS: '找到多个不同的总额，需要手动核对',
  CURRENCY_UNKNOWN: '金额不是美元，需要手动核对（不做汇率换算）',
  PARTIAL_SUPPORT: '这个平台只能识别，金额需要手动补',
  PLATFORM_AMBIGUOUS: '有邮件同时像多个平台（已列入待查看邮件）',
  UNCERTAIN: '有邮件看不出是不是外卖消费（已列入待查看邮件）'
};

/** 整轮运行失败的代码（首页红色提示用）；其余代码只是某封邮件的问题，显示在平台状态里。 */
var GMAIL_RUN_FAILURE_CODES = { AUTH_REVOKED: true, QUOTA_EXCEEDED: true, GMAIL_FAILED: true, GMAIL_SERVICE_MISSING: true,
  SETUP_REQUIRED: true, NO_CATEGORY: true };

/** 金额为空的收据账目写在备注里的说明（是规则给的固定文字，不是邮件内容）。 */
var RECEIPT_AMOUNT_NOTE = {
  TOTAL_NOT_FOUND: '自动识别：没找到实付总额，请对照邮件补填',
  MULTIPLE_TOTALS: '自动识别：找到多个不同的总额，请对照邮件补填',
  CURRENCY_UNKNOWN: '自动识别：金额不是美元，请按实际扣款补填',
  PARTIAL_SUPPORT: '自动识别：这个平台的金额需要手动补填'
};
var REFUND_UNLINKED_NOTE = '未能自动关联原订单';

function receiptError_(code) {
  var e = new Error(code);
  e.receiptCode = code;
  return e;
}

function gmailSourceKey(messageId) {
  return GMAIL_KEY_PREFIX + messageId;
}

/** 键中加入平台名：不同平台的订单号即使相同也不会冲突（spec 6.5 第 5 步）。 */
function orderSourceKey(platformId, orderRef) {
  return 'order:' + platformId + ':' + orderRef + ':receipt';
}

/** Gmail 出错 → 错误代码（只看错误类型，不记录错误信息本身）。 */
function gmailErrorCode(e) {
  if (e && e.receiptCode) return e.receiptCode;
  var s = String((e && e.message) || e || '');
  if (/quota|rate ?limit|too many|429|limit exceeded/i.test(s)) return 'QUOTA_EXCEEDED';
  if (/auth|permission|401|403|forbidden|invalid_grant|unauthori[sz]ed|access denied|scope/i.test(s)) return 'AUTH_REVOKED';
  return 'GMAIL_FAILED';
}

/** Gmail 网页中打开这封邮件的链接（格式【未核实】；打不开时可按到达日期在 Gmail 中查找）。 */
function gmailMessageLink(messageId) {
  return GMAIL_MESSAGE_ID_RE.test(String(messageId || '')) ? 'https://mail.google.com/mail/u/0/#all/' + messageId : null;
}

// ---------------- 读邮件 ----------------

/**
 * Gmail API 的 Message（format: 'full'）→ 简化的邮件对象 {id, internalDate, from, subject, html, text}。
 * decode(data) 把正文的 data 字段解码成文字（正式运行时用 Utilities，测试时用 Buffer）。附件不读。
 * 这个对象只在内存里使用，不保存、不打印。
 */
function simplifyGmailMessage(msg, decode) {
  var headers = {};
  var payload = (msg && msg.payload) || {};
  (payload.headers || []).forEach(function (h) {
    var k = String((h && h.name) || '').toLowerCase();
    if (k && !Object.prototype.hasOwnProperty.call(headers, k)) headers[k] = String(h.value || '');
  });
  var html = [], text = [];
  (function walk(part, depth) {
    if (!part || depth > 12) return;
    var mime = String(part.mimeType || '').toLowerCase();
    if (part.filename) return;
    if (part.body && part.body.data !== undefined && part.body.data !== null && (mime === 'text/html' || mime === 'text/plain')) {
      var s = '';
      try { s = String(decode(part.body.data) || ''); } catch (e) { s = ''; }
      (mime === 'text/html' ? html : text).push(s);
    }
    (part.parts || []).forEach(function (p) { walk(p, depth + 1); });
  })(payload, 0);
  return {
    id: String((msg && msg.id) || ''), internalDate: Number(msg && msg.internalDate),
    labelIds: (msg && msg.labelIds) || [],
    from: headers.from || '', subject: headers.subject || '', html: html.join('\n'), text: text.join('\n')
  };
}

/** 下单时间（D2）：只有平台提供了 extractOrderTime 和 bodyTimeZone、且结果在到达前 3 天内时才用，否则用到达时间。 */
function receiptOccurredAt_(p, text, arrival) {
  if (!arrival) return null;
  if (typeof p.extractOrderTime !== 'function' || !p.bodyTimeZone) return arrival;
  var t = null;
  try { t = p.extractOrderTime(text, p.bodyTimeZone); } catch (e) { t = null; }
  if (!(t instanceof Date) || isNaN(t.getTime())) return arrival;
  var a = arrival.getTime();
  if (t.getTime() < a - ORDER_TIME_MAX_EARLY_MS || t.getTime() > a + 10 * 60000) return arrival;
  return t;
}

/** Return only a one-way hash for a restaurant name parsed from a DoorDash subject. */
function restaurantPrivacyKey_(subject) {
  var m = /(?:your\s+)?order\s+from\s+(.+?)\s*$/i.exec(String(subject || '')) ||
    /order\s+confirmation\s+for\s+(.+?)\s*$/i.exec(String(subject || ''));
  if (!m) return null;
  var name = String(m[1] || '').replace(/\s+[|–—-].*$/, '').trim()
    .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!name) return null;
  if (typeof Utilities !== 'undefined' && Utilities.computeDigest && Utilities.DigestAlgorithm) {
    try {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, name, Utilities.Charset.UTF_8);
      return 'sha256:' + bytes.map(function (b) { return ('0' + ((Number(b) + 256) % 256).toString(16)).slice(-2); }).join('');
    } catch (e) { /* test/runtime fallback below */ }
  }
  // Deterministic fallback for the Node test harness. GAS uses SHA-256 above.
  var h = 2166136261;
  for (var i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return 'fnv32:' + ('00000000' + h.toString(16)).slice(-8);
}

/**
 * 解析一封邮件（spec 6.5 第 1–4 步），不读写账本。platforms = 注册表（含已关闭的平台）。返回：
 *   {status: 'no_platform' | 'ambiguous' | 'disabled' | 'parsed', messageId, arrivalAt, senderDomain,
 *    platform?, platformIds?, kind?, cents?, reason?, label?, currency?, orderRef?, occurredAt?}
 */
function parseReceiptMessage(m, platforms) {
  var from = parseFromHeader(m.from);
  var subject = normalizeReceiptText(m.subject).replace(/\n/g, ' ');
  var t = Number(m.internalDate);
  var arrival = isFinite(t) && t > 0 ? new Date(t) : null;
  var out = { messageId: String(m.id || ''), arrivalAt: arrival, senderDomain: from.domain };
  var matched = (platforms || []).filter(function (p) {
    try { return !!(typeof p.matchMessage === 'function' ? p.matchMessage(from, subject) : p.matchSender(from)); } catch (e) { return false; }
  });
  if (!matched.length) { out.status = 'no_platform'; return out; }
  if (matched.length > 1) {
    out.status = 'ambiguous';
    out.platformIds = matched.map(function (p) { return p.id; });
    return out;
  }
  var p = matched[0];
  out.platform = p;
  if (!receiptPlatformActive(p)) { out.status = 'disabled'; return out; }
  out.status = 'parsed';
  var text = m.html ? htmlToText(m.html) : '';
  if (!text) text = normalizeReceiptText(m.text);
  var links = extractHtmlLinks(m.html);
  var kind = p.classify(subject, text, from);
  if (['receipt', 'refund', 'other', 'uncertain'].indexOf(kind) < 0) kind = 'uncertain';
  out.kind = kind;
  if (kind === 'other') return out;
  if (kind === 'uncertain') out.why = receiptUncertainWhy_(subject, text);
  // 预估总额（DoorDash 订单确认）：照常记账，但账目标“待核对金额”
  out.amountEstimate = kind === 'receipt' && typeof p.amountIsEstimate === 'function' && !!p.amountIsEstimate(subject, text);
  if (out.amountEstimate) out.why = 'ESTIMATED_TOTAL_REVIEW';
  var amt = (kind === 'refund' ? p.extractRefund(text) : p.extractTotal(text)) || { cents: null, reason: 'TOTAL_NOT_FOUND' };
  out.cents = typeof amt.cents === 'number' && amt.cents >= 0 ? amt.cents : null;
  out.reason = out.cents === null ? (amt.reason || 'TOTAL_NOT_FOUND') : null;
  out.label = amt.label || null;
  out.currency = amt.currency || null;
  if (p.support_status === 'partial' && kind !== 'uncertain') { out.cents = null; out.reason = 'PARTIAL_SUPPORT'; }
  out.orderRef = typeof p.extractOrderRef === 'function' ? (p.extractOrderRef(text, links) || null) : null;
  out.restaurantKey = p.id === 'doordash' ? restaurantPrivacyKey_(subject) : null;
  out.occurredAt = receiptOccurredAt_(p, text, arrival);
  return out;
}

// ---------------- 写入账本 ----------------

function processedMap_(repo) {
  var map = {};
  repo.list('processed_sources').forEach(function (p) { map[p.source_key] = p; });
  return map;
}

function recordSource_(repo, key, entryId, outcome, now) {
  repo.insert('processed_sources', { source_key: key, entry_id: entryId || null, outcome: outcome, processed_at: now.toISOString() });
}

/** 收据的类别：未归档的“餐饮”（平台规则的 category），没有就用“未分类”。 */
function receiptCategoryId_(repo, p) {
  if (p.category_id && repo.list('categories').some(function (x) { return x.id === p.category_id && x.type === 'expense' && !x.archived; })) return p.category_id;
  var cats = repo.list('categories');
  var name = p.category || '餐饮';
  var c = cats.filter(function (x) { return x.type === 'expense' && !x.archived && x.name === name; })[0] ||
    cats.filter(function (x) { return x.system_key === UNCATEGORIZED_KEY; })[0];
  if (!c) throw receiptError_('NO_CATEGORY');
  return c.id;
}

/** 同一平台同一订单的原收据账目（未删除或已删除都算；被彻底清除的找不到）。 */
function originalForOrder_(all, processed, platformId, orderRef) {
  if (!orderRef) return null;
  var row = processed[orderSourceKey(platformId, orderRef)];
  var byKey = row && row.entry_id ? findById_(all, row.entry_id) : null;
  if (byKey) return byKey;
  return all.filter(function (e) {
    return e.channel === 'gmail_receipt' && e.platform === platformId && e.order_ref === orderRef && !e.is_refund;
  })[0] || null;
}

function buildReceiptEntry_(ev, categoryId, id, now, extra) {
  var ts = now.toISOString();
  var at = ev.occurredAt || now;
  var e = {
    id: id, type: 'expense', amount_cents: ev.cents, occurred_at: at.toISOString(), month_ny: monthNY(at), date_ny: dateNY(at),
    category_id: categoryId, income_source_id: null, merchant: ev.merchant || ev.platform.displayName,
    note: ev.cents === null ? (RECEIPT_AMOUNT_NOTE[ev.reason] || RECEIPT_AMOUNT_NOTE.TOTAL_NOT_FOUND) : '',
    channel: 'gmail_receipt', platform: ev.platform.id, is_refund: false, refund_of: null, flag_dup: false, dup_group: null,
    flag_amount_review: !!ev.amountEstimate && ev.cents !== null, source_key: gmailSourceKey(ev.messageId), order_ref: ev.orderRef || null,
    restaurant_key: ev.restaurantKey || null,
    created_at: ts, updated_at: ts, deleted_at: null
  };
  return Object.assign(e, extra || {});
}

function withinMs_(a, b, ms) {
  var x = new Date(a).getTime(), y = new Date(b).getTime();
  return !isNaN(x) && !isNaN(y) && Math.abs(x - y) <= ms;
}

function dismissedMap_(repo) {
  var d = {};
  repo.list('dup_dismissed').forEach(function (r) { d[r.pair_key] = true; });
  return d;
}

/** D7：缺少订单标识时，仅同一 DoorDash 餐厅的 6 小时内收据才标“待核对重复”。 */
function flagD7_(repo, entry, newId) {
  if (!entry.restaurant_key) return 0;
  var all = repo.list('entries');
  var self = findById_(all, entry.id) || entry;
  var dismissed = dismissedMap_(repo);
  var cands = all.filter(function (o) {
    return o.id !== self.id && isLive(o) && o.channel === 'gmail_receipt' && o.platform === self.platform && !o.is_refund &&
      !!o.restaurant_key && o.restaurant_key === self.restaurant_key &&
      withinMs_(o.occurred_at, self.occurred_at, D7_WINDOW_MS) && !dismissed[dupPairKey(self.id, o.id)];
  });
  return svcFlagDupGroup_(repo, self, cands, newId);
}

/** 同一平台、同一订单（或都没有订单标识）、同金额、1 天内的两封不同退款邮件 → 标“待核对重复”（spec 4.4）。 */
function flagRefundDups_(repo, entry, newId) {
  if (entry.amount_cents === null) return 0;
  var all = repo.list('entries');
  var self = findById_(all, entry.id) || entry;
  var dismissed = dismissedMap_(repo);
  var cands = all.filter(function (o) {
    return o.id !== self.id && isLive(o) && o.channel === 'gmail_receipt' && o.platform === self.platform && o.is_refund &&
      o.amount_cents === self.amount_cents && (o.order_ref || null) === (self.order_ref || null) &&
      withinMs_(o.occurred_at, self.occurred_at, REFUND_DUP_WINDOW_MS) && !dismissed[dupPairKey(self.id, o.id)];
  });
  return svcFlagDupGroup_(repo, self, cands, newId);
}

function safely_(label, fn) {
  try {
    return fn() || 0;
  } catch (e) {
    console.error(label + '：' + (e && e.name ? e.name : 'Error'));
    return 0;
  }
}

/**
 * applyReceiptEvent（spec 6.5 第 5 步、6.6）。ev = {platform, kind: 'receipt'|'refund', cents, reason, orderRef, occurredAt, messageId}。
 * 先写账目、再写凭据：中途中断时，下次会发现账本里已有这个凭据的账目，只补写凭据，不会多记。
 * 返回 {outcome, entry?, flagged}。outcome 与 processed_sources.outcome 相同（另有 skipped / repaired）。
 */
function svcApplyReceiptEvent(repo, ev, now, newId) {
  var msgKey = gmailSourceKey(ev.messageId);
  var processed = processedMap_(repo);
  if (processed[msgKey]) return { outcome: 'skipped', flagged: 0 };
  var all = repo.list('entries');
  var p = ev.platform;
  var orderKey = ev.orderRef ? orderSourceKey(p.id, ev.orderRef) : null;

  var existing = all.filter(function (e) { return e.source_key === msgKey; })[0];
  if (existing) {
    recordSource_(repo, msgKey, existing.id, existing.is_refund ? 'refund_created' : 'created', now);
    if (orderKey && !existing.is_refund && !processed[orderKey]) recordSource_(repo, orderKey, existing.id, 'created', now);
    return { outcome: 'repaired', entry: existing, flagged: 0 };
  }

  var orig = originalForOrder_(all, processed, p.id, ev.orderRef);
  var entry, flagged = 0;

  if (ev.kind === 'refund') {
    var linked = orig && !orig.is_refund ? orig : null;
    entry = buildReceiptEntry_(ev, linked ? linked.category_id : receiptCategoryId_(repo, p), newId(), now, {
      amount_cents: ev.cents === null ? null : -Math.abs(ev.cents), is_refund: true, refund_of: linked ? linked.id : null
    });
    var notes = [];
    if (!linked) notes.push(REFUND_UNLINKED_NOTE);
    if (ev.cents === null) notes.push(RECEIPT_AMOUNT_NOTE[ev.reason] || RECEIPT_AMOUNT_NOTE.TOTAL_NOT_FOUND);
    entry.note = notes.join('；');
    repo.insert('entries', entry);
    recordSource_(repo, msgKey, entry.id, 'refund_created', now);
    svcOnEntryCreated_(repo, entry);
    flagged += safely_('退款重复检查失败', function () { return flagRefundDups_(repo, entry, newId); });
    flagged += safely_('重复检查失败', function () { return svcFlagCrossChannelDups_(repo, entry, newId); });
    touchMonths_(repo, [entry.month_ny], now);
    return { outcome: 'refund_created', entry: entry, flagged: flagged };
  }

  // 收据：同一平台同一订单已经记过 → 不新增（spec 6.6）
  if (orderKey && (processed[orderKey] || orig)) {
    if (!orig || orig.deleted_at) {
      recordSource_(repo, msgKey, orig ? orig.id : null, 'duplicate_noop', now);   // 原账目已删除：只记录凭据
      return { outcome: 'duplicate_noop', flagged: 0 };
    }
    // 金额不同，或新收据读不出金额（无法确认是否相同）→ 原账目标“待核对金额”
    if (orig.amount_cents !== null && (ev.cents === null || ev.cents !== orig.amount_cents)) {
      if (!orig.flag_amount_review) repo.update('entries', orig.id, { flag_amount_review: true, updated_at: now.toISOString() });
      touchMonths_(repo, [orig.month_ny], now);
      recordSource_(repo, msgKey, orig.id, 'revision_flagged', now);
      return { outcome: 'revision_flagged', entry: orig, flagged: 1 };
    }
    recordSource_(repo, msgKey, orig.id, 'duplicate_noop', now);
    return { outcome: 'duplicate_noop', flagged: 0 };
  }

  entry = buildReceiptEntry_(ev, receiptCategoryId_(repo, p), newId(), now);
  repo.insert('entries', entry);
  recordSource_(repo, msgKey, entry.id, 'created', now);
  if (orderKey) recordSource_(repo, orderKey, entry.id, 'created', now);
  svcOnEntryCreated_(repo, entry);
  if (!ev.orderRef && p.id === 'doordash') flagged += safely_('D7 检查失败', function () { return flagD7_(repo, entry, newId); });
  flagged += safely_('重复检查失败', function () { return svcFlagCrossChannelDups_(repo, entry, newId); });
  touchMonths_(repo, [entry.month_ny], now);
  return { outcome: 'created', entry: entry, flagged: flagged };
}

// ---------------- D16：待查看邮件 ----------------

/** 加入“待查看邮件”（只保存邮件编号、平台、到达时间、原因代码）。已在列表里（包括已查看过的）就不再加。 */
function svcAddPendingMail_(repo, messageId, platformIds, receivedAt, reason, now, senderDomain, amountCents) {
  if (!tableReady_(repo, 'gmail_pending')) throw receiptError_('SETUP_REQUIRED');
  if (repo.list('gmail_pending').some(function (r) { return r.message_id === messageId; })) return false;
  repo.insert('gmail_pending', { message_id: messageId, platforms: platformIds.join(','), received_at: receivedAt.toISOString(),
    sender_domain: senderDomain || null, amount_cents: amountCents === undefined ? null : amountCents,
    reason: reason, reviewed_at: null, created_at: now.toISOString() });
  return true;
}

function pendingMailRows_(repo) {
  if (!tableReady_(repo, 'gmail_pending')) return [];
  var muted = {};
  if (tableReady_(repo, 'mail_senders')) repo.list('mail_senders').filter(function (s) { return s.mode === 'muted'; }).forEach(function (s) { muted[s.domain] = true; });
  return repo.list('gmail_pending').filter(function (r) { return !r.reviewed_at && !muted[r.sender_domain]; });
}

/** 小助手 pending_items 用的“待查看邮件”数（spec 7A.3）。 */
function svcPendingMailCount_(repo) {
  return pendingMailRows_(repo).length;
}

/** “已查看”：从列表中移除（只写 reviewed_at，凭据不动，之后同一封邮件也不会再列出）。 */
function svcMarkMailReviewed(repo, messageId, now) {
  var id = String(messageId || '');
  if (!GMAIL_MESSAGE_ID_RE.test(id)) throw UserError('邮件编号不正确');
  if (!tableReady_(repo, 'gmail_pending')) throw UserError('找不到这封邮件');
  var row = repo.list('gmail_pending').filter(function (r) { return r.message_id === id; })[0];
  if (!row) throw UserError('找不到这封邮件');
  if (!row.reviewed_at) repo.update('gmail_pending', id, { reviewed_at: now.toISOString() });
  return { ok: true, pending_count: svcPendingMailCount_(repo) };
}

function pendingById_(repo, messageId) {
  var id = String(messageId || '');
  if (!GMAIL_MESSAGE_ID_RE.test(id) || !tableReady_(repo, 'gmail_pending')) throw UserError('找不到这封邮件');
  var row = repo.list('gmail_pending').filter(function (r) { return r.message_id === id; })[0];
  if (!row) throw UserError('找不到这封邮件');
  return row;
}

function svcMuteMailSender(repo, messageId, now) {
  var row = pendingById_(repo, messageId);
  if (!row.sender_domain) throw UserError('这封邮件没有可静音的商家网域');
  upsertMailSender_(repo, { domain: row.sender_domain, mode: 'muted', display_name: row.sender_domain }, now);
  return { ok: true, pending_count: svcPendingMailCount_(repo) };
}

function svcSavePendingMailEntry(repo, messageId, input, now, newId) {
  var row = pendingById_(repo, messageId);
  var key = gmailSourceKey(row.message_id);
  var existing = repo.list('entries').filter(function (e) { return e.source_key === key; })[0];
  if (existing) {
    if (!processedMap_(repo)[key]) recordSource_(repo, key, existing.id, 'created_manual', now);
    if (!row.reviewed_at) repo.update('gmail_pending', row.message_id, { reviewed_at: now.toISOString() });
    return svcGetEntry(repo, existing.id);
  }
  if (row.reviewed_at) throw UserError('这封邮件已经处理过');
  var saved = svcSaveEntry(repo, input, now, newId, { channel: 'gmail_receipt', platform: row.sender_domain ? 'mail:' + row.sender_domain : 'unlisted', source_key: key });
  recordSource_(repo, key, saved.id, 'created_manual', now);
  repo.update('gmail_pending', row.message_id, { reviewed_at: now.toISOString() });
  return svcGetEntry(repo, saved.id);
}

function svcAddSenderAndRecordPending(repo, messageId, categoryId, now, newId) {
  var row = pendingById_(repo, messageId);
  if (!row.sender_domain) throw UserError('这封邮件没有可保存的商家网域');
  var key = gmailSourceKey(row.message_id);
  var existing = repo.list('entries').filter(function (e) { return e.source_key === key; })[0];
  if (existing) {
    if (!processedMap_(repo)[key]) recordSource_(repo, key, existing.id, 'created_manual', now);
    if (!row.reviewed_at) repo.update('gmail_pending', row.message_id, { reviewed_at: now.toISOString() });
    return { entry: svcGetEntry(repo, existing.id), sender: senderForDomain_(repo, row.sender_domain) };
  }
  if (row.reviewed_at) throw UserError('这封邮件已经处理过');
  if (typeof row.amount_cents !== 'number' || !isFinite(row.amount_cents) || row.amount_cents < 0) {
    throw UserError('这封邮件没有读到唯一金额，请先手动记账');
  }
  var category = repo.list('categories').filter(function (c) { return c.id === categoryId && c.type === 'expense' && !c.archived; })[0];
  if (!category) throw UserError('请选择有效的支出类别');
  var at = row.received_at ? new Date(row.received_at) : now;
  if (isNaN(at.getTime())) throw UserError('邮件日期不正确，请先手动记账');
  var sender = upsertMailSender_(repo, { domain: row.sender_domain, display_name: row.sender_domain, category_id: categoryId, mode: 'auto' }, now);
  var amount = (row.amount_cents / 100).toFixed(2);
  var saved = svcSaveEntry(repo, { type: 'expense', amount: amount, local_datetime: localNY(at), category_id: sender.category_id,
    merchant: sender.display_name, note: '', is_refund: false }, now, newId,
    { channel: 'gmail_receipt', platform: 'mail:' + sender.domain, source_key: key });
  recordSource_(repo, key, saved.id, 'created_manual', now);
  repo.update('gmail_pending', row.message_id, { reviewed_at: now.toISOString() });
  return { entry: svcGetEntry(repo, saved.id), sender: sender };
}

var GENERIC_TOTAL_LABELS_ = ['Grand Total', 'Order Total', 'Amount Paid', 'Total Charged', 'Total'].concat(['Grand Total', 'Amount Paid', '总计', '实付']);
var GENERIC_TOTAL_EXCLUDES_ = ['Subtotal', 'Sub-total', 'Sub total', 'Total Savings'];
function genericReceiptLike_(subject) { return /receipt|invoice|payment|order|confirmation|收据|订单|付款|账单/i.test(String(subject || '')); }
function genericTotal_(text) {
  return extractLabeledAmount(text, GENERIC_TOTAL_LABELS_, GENERIC_TOTAL_EXCLUDES_.concat(['小计', '优惠', '折扣', 'Total Savings']), { finalTotal: true }).cents;
}
function genericReceiptKind_(subject, text) {
  return classifyBySubject(subject, text, {
    receipt: /\breceipt\b|\border confirmation\b|\byour order (?:from|with)\b|收据|订单已(?:支付|付款)/i,
    promo: /\d+\s*%\s*off|\bpromo|\boffers?\b|free delivery|\bsave\s+\$|优惠|折扣/i,
    amountLabels: GENERIC_TOTAL_LABELS_
  });
}

function senderForDomain_(repo, domain) {
  if (!domain || !tableReady_(repo, 'mail_senders')) return null;
  return repo.list('mail_senders').filter(function (r) { return r.domain === domain; })[0] || null;
}

function upsertMailSender_(repo, row, now) {
  var domain = String(row.domain || '').toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw UserError('发件网域格式不正确');
  if (['auto', 'muted'].indexOf(row.mode) < 0) throw UserError('名单模式不正确');
  var existing = senderForDomain_(repo, domain);
  var safe = { domain: domain, display_name: cleanText_(row.display_name || domain, 100) || domain,
    category_id: row.category_id || null, mode: row.mode, created_at: existing ? existing.created_at : (row.created_at || now.toISOString()) };
  if (safe.mode === 'auto') {
    var category = repo.list('categories').filter(function (c) { return c.id === safe.category_id && c.type === 'expense' && !c.archived; })[0];
    if (!category) throw UserError('请选择有效的支出类别');
  }
  if (existing) repo.update('mail_senders', domain, safe); else repo.insert('mail_senders', safe);
  return safe;
}

/**
 * 处理一封新邮件（spec 6.5 共用流程）。返回 {outcome, platformIds, code?, created?, flagged?, pending_added?, entry?}。
 * code 是这封邮件的问题代码（例如 CURRENCY_UNKNOWN），用于平台状态。
 */
function svcHandleReceiptMessage(repo, m, platforms, now, newId) {
  var res = { outcome: null, platformIds: [], code: null, created: 0, flagged: 0, pending_added: 0, entry: null };
  if (!GMAIL_MESSAGE_ID_RE.test(String(m.id || ''))) { res.outcome = 'invalid'; return res; }
  var key = gmailSourceKey(m.id);
  if (processedMap_(repo)[key]) { res.outcome = 'skipped'; return res; }
  var r = parseReceiptMessage(m, platforms);
  var arrival = r.arrivalAt || now;
  if (r.status === 'no_platform') {
    var subject = normalizeReceiptText(m.subject || '');
    var sender = senderForDomain_(repo, r.senderDomain);
    var body = m.html ? htmlToText(m.html) : normalizeReceiptText(m.text || '');
    var cents = genericTotal_(body);
    var genericKind = genericReceiptKind_(subject, body);
    if (genericKind === 'other' && textHas(subject + '\n' + body, RECEIPT_PROMO_TEXT_)) {
      recordSource_(repo, key, null, 'ignored_not_receipt', now);
      res.outcome = 'ignored_not_receipt';
      return res;
    }
    if (sender && sender.mode === 'auto' && genericKind === 'receipt' && cents !== null) {
      var customPlatform = { id: 'mail:' + sender.domain, displayName: sender.display_name || sender.domain,
        category_id: sender.category_id, merchantAliases: [sender.display_name || sender.domain, sender.domain] };
      var applied = svcApplyReceiptEvent(repo, { platform: customPlatform, kind: 'receipt', cents: cents, reason: null,
        orderRef: null, occurredAt: arrival, messageId: m.id, merchant: customPlatform.displayName }, now, newId);
      res.outcome = applied.outcome; res.entry = applied.entry || null;
      res.created = applied.outcome === 'created' ? 1 : 0; res.flagged = applied.flagged || 0;
    } else if ((sender && sender.mode === 'auto') || genericReceiptLike_(subject) || (m.labelIds || []).indexOf('CATEGORY_PURCHASES') >= 0) {
      var pendingReason = sender && sender.mode === 'auto' ? 'AUTO_SENDER_NEEDS_REVIEW' : 'UNLISTED';
      if (svcAddPendingMail_(repo, m.id, [], arrival, pendingReason, now, r.senderDomain, cents)) res.pending_added = 1;
      recordSource_(repo, key, null, 'unlisted_pending', now);
      res.outcome = 'uncertain';
      if (sender && sender.mode === 'auto') res.code = pendingReason;
    } else {
      recordSource_(repo, key, null, 'ignored_not_receipt', now);
      res.outcome = 'ignored_not_receipt';
    }
    return res;
  }
  if (r.status === 'ambiguous' || (r.status === 'parsed' && r.kind === 'uncertain')) {
    var ids = r.status === 'ambiguous' ? r.platformIds : [r.platform.id];
    var code = r.status === 'ambiguous' ? 'PLATFORM_AMBIGUOUS' : 'UNCERTAIN';
    if (svcAddPendingMail_(repo, r.messageId, ids, arrival, code, now, r.senderDomain, r.cents)) res.pending_added = 1;   // 先列入，再写凭据
    recordSource_(repo, key, null, 'uncertain', now);
    res.outcome = 'uncertain';
    res.platformIds = ids;
    res.code = code;
    return res;
  }
  res.platformIds = [r.platform.id];
  if (r.status === 'disabled') {
    recordSource_(repo, key, null, 'ignored_platform_disabled', now);
    res.outcome = 'ignored_platform_disabled';
    return res;
  }
  if (r.kind === 'other') {
    recordSource_(repo, key, null, 'ignored_not_receipt', now);
    res.outcome = 'ignored_not_receipt';
    return res;
  }
  // New receipts need a unique final total. Keep known-order revisions and recovery unchanged.
  var processed = processedMap_(repo);
  var entries = repo.list('entries');
  var knownOrder = r.orderRef && (processed[orderSourceKey(r.platform.id, r.orderRef)] || originalForOrder_(entries, processed, r.platform.id, r.orderRef));
  var existingMessage = entries.some(function (e) { return e.source_key === key; });
  if (r.kind === 'receipt' && r.cents === null && !knownOrder && !existingMessage) {
    if (svcAddPendingMail_(repo, r.messageId, [r.platform.id], arrival, r.reason, now, r.senderDomain, null)) res.pending_added = 1;
    recordSource_(repo, key, null, 'uncertain', now);
    res.outcome = 'uncertain'; res.code = r.reason;
    return res;
  }
  var a = svcApplyReceiptEvent(repo, { platform: r.platform, kind: r.kind, cents: r.cents, reason: r.reason, orderRef: r.orderRef,
    occurredAt: r.occurredAt || arrival, messageId: r.messageId, restaurantKey: r.restaurantKey, amountEstimate: r.amountEstimate }, now, newId);
  res.outcome = a.outcome;
  res.entry = a.entry || null;
  res.flagged = a.flagged || 0;
  res.created = a.outcome === 'created' || a.outcome === 'refund_created' ? 1 : 0;
  if (res.created && r.cents === null) res.code = r.reason;
  res.arrivalAt = arrival;
  return res;
}

// ---------------- 轮询（spec 6.4） ----------------

function gmailTablesReady_(repo) {
  return GMAIL_TABLES.every(function (t) { return tableReady_(repo, t); });
}

/**
 * 一轮轮询。client = {list(q, pageToken, max) → {ids, nextPageToken}, get(id) → 简化的邮件对象}。
 * 一次合并搜索、按 nextPageToken 翻页直到读完、只读取没处理过的邮件；按平台更新状态（含“到达 → 入账”耗时）。
 * clock：返回当前毫秒数（默认 Date.now，测试可注入），超过 POLL_TIME_BUDGET_MS 就停止本轮（每封邮件的结果已保存）。
 * 返回只含数量和代码的结果（不含任何邮件内容）。
 */
function svcPollReceipts(repo, client, now, platforms, newId, clock) {
  clock = clock || function () { return Date.now(); };
  var started = clock();
  var out = { listed: 0, read: 0, created: 0, flagged: 0, pending_added: 0, ignored: 0, skipped: 0, errors: 0, pages: 0,
    error_code: null, volume_high: false, too_many_pages: false, time_limited: false };
  if (!gmailTablesReady_(repo)) {
    out.error_code = 'SETUP_REQUIRED';
    if (tableReady_(repo, 'channel_status')) svcRecordChannelRun_(repo, 'gmail', now, { ok: false, created: 0, error_code: 'SETUP_REQUIRED' });
    return out;
  }
  var active = (platforms || []).filter(receiptPlatformActive);
  var per = {};
  active.forEach(function (p) { per[p.id] = { created: 0, code: null, latency_sec: null }; });
  var q = buildReceiptQuery(platforms, tableReady_(repo, 'mail_senders') ? repo.list('mail_senders') : []);
  var ids = [];
  if (q) {
    var seen = {}, token = null;
    try {
      do {
        var page = client.list(q, token, GMAIL_PAGE_SIZE) || {};
        out.pages++;
        (page.ids || []).forEach(function (id) { id = String(id); if (!seen[id]) { seen[id] = true; ids.push(id); } });
        token = page.nextPageToken || null;
      } while (token && out.pages < GMAIL_MAX_PAGES);
      out.too_many_pages = !!token;   // 还有下一页但已到上限：记录代码，不悄悄停下
    } catch (e) {
      out.error_code = gmailErrorCode(e);
      svcRecordChannelRun_(repo, 'gmail', now, { ok: false, created: 0, error_code: out.error_code });
      return out;
    }
  }
  out.listed = ids.length;
  var processed = processedMap_(repo);
  var todo = ids.filter(function (id) { return !processed[gmailSourceKey(id)]; });
  var runFailure = null;
  for (var i = 0; i < todo.length; i++) {
    if (clock() - started > POLL_TIME_BUDGET_MS) { out.time_limited = true; break; }
    if (out.read >= READ_VOLUME_LIMIT) { out.volume_high = true; break; }
    var m;
    try {
      out.read++; // 读取尝试计入每轮上限，即使 Gmail API 抛错也不能无限重试
      m = client.get(todo[i]);
    } catch (e1) {
      var c1 = gmailErrorCode(e1);
      if (c1 === 'AUTH_REVOKED' || c1 === 'QUOTA_EXCEEDED' || c1 === 'GMAIL_SERVICE_MISSING') { runFailure = c1; break; }
      out.errors++;
      continue;
    }
    try {
      var r = svcHandleReceiptMessage(repo, m, platforms, now, newId);
      out.created += r.created;
      out.flagged += r.flagged;
      out.pending_added += r.pending_added;
      if (/^ignored_/.test(r.outcome)) out.ignored++;
      if (r.outcome === 'skipped') out.skipped++;
      r.platformIds.forEach(function (pid) {
        var s = per[pid];
        if (!s) return;
        if (r.code) s.code = r.code;
        if (r.created) {
          s.created++;
          s.latency_sec = Math.max(0, Math.round((now.getTime() - r.arrivalAt.getTime()) / 1000));
        }
      });
    } catch (e2) {
      out.errors++;
      if (e2 && e2.receiptCode === 'NO_CATEGORY') { runFailure = 'NO_CATEGORY'; break; }
      console.error('收据处理失败：' + (e2 && e2.name ? e2.name : 'Error'));
    }
  }
  out.volume_high = out.volume_high || (out.read >= READ_VOLUME_LIMIT && todo.length > out.read);
  out.error_code = runFailure || (out.errors ? 'MESSAGE_FAILED' : null) || (out.too_many_pages ? 'TOO_MANY_PAGES' : null) ||
    (out.volume_high ? 'READ_VOLUME_HIGH' : null);
  active.forEach(function (p) {
    var s = per[p.id];
    svcRecordChannelRun_(repo, 'gmail:' + p.id, now, { ok: !runFailure, created: s.created, error_code: s.code, latency_sec: s.latency_sec });
  });
  svcRecordChannelRun_(repo, 'gmail', now, { ok: !runFailure, created: out.created, error_code: out.error_code });
  return out;
}

// ---------------- G1 试运行（spec 6.8） ----------------

/**
 * 试运行的一行日志：邮件编号后 6 位 | 到达时间（费城） | 发件域名 | 分类 | 金额和币种 | 是否找到订单号 | 匹配的总额标签。
 * 只输出这些由规则算出来的值，**不输出主题、正文或任何原文片段**（被判为 other 的邮件连金额也不输出）。
 */
function dryRunLine(m, platforms) {
  var r = parseReceiptMessage(m, platforms);
  var cls = r.status === 'parsed' ? r.kind : r.status === 'ambiguous' ? 'PLATFORM_AMBIGUOUS'
    : r.status === 'disabled' ? 'PLATFORM_DISABLED' : 'NO_PLATFORM';
  var detail = r.status === 'parsed' && r.kind !== 'other';
  var total = '-';
  if (detail) {
    total = r.cents !== null ? formatCents(r.cents) + ' USD'
      : r.reason + (r.reason === 'CURRENCY_UNKNOWN' && r.currency ? '(' + String(r.currency).slice(0, 4) + ')' : '');
  }
  return [
    '…' + String(r.messageId).slice(-6),
    r.arrivalAt ? localNY(r.arrivalAt).replace('T', ' ') : '?',
    r.senderDomain || '?',
    cls + (r.status === 'ambiguous' ? '(' + r.platformIds.join('/') + ')' : '') + (r.why ? '(' + r.why + ')' : ''),
    total,
    '订单号:' + (detail ? (r.orderRef ? '有' : '无') : '-'),
    (r.platform && r.platform.id === 'uber' ? '行程总额标签:' : '总额标签:') + (detail && r.label ? r.label : '未找到')
  ].join(' | ');
}

/**
 * dryRunReceipts 的核心：读取这个平台最近 10 封邮件，只用 log 输出 dryRunLine。不碰账本、不写任何东西。
 * 返回 {platform, count}。
 */
function svcDryRunReceipts(client, platformId, platforms, log) {
  var p = findReceiptPlatform(platforms, String(platformId || ''));
  if (!p) {
    throw UserError('没有这个平台。请运行 dryRunReceipts 并填写其中一个：' + platforms.map(function (x) { return x.id; }).join('、'));
  }
  var page = client.list(platformQuery(p), null, GMAIL_DRY_RUN_COUNT) || {};
  var ids = (page.ids || []).slice(0, GMAIL_DRY_RUN_COUNT);
  log('G1 试运行：' + p.displayName + '（' + p.id + '），最近 ' + ids.length + ' 封。只显示：编号后 6 位 | 到达时间 | 发件域名 | 分类 | 金额 | 订单号 | 总额标签；' +
    '不显示邮件内容，不写账本。');
  ids.forEach(function (id) {
    try {
      log(dryRunLine(client.get(id), platforms));
    } catch (e) {
      log('…' + String(id).slice(-6) + ' | 读取或识别失败：' + gmailErrorCode(e));
    }
  });
  return { platform: p.id, count: ids.length };
}

function svcDryRunBroadScan(client, platforms, senderRows, log) {
  var pBuiltins = (platforms || []).map(function (p) { return p.gmailQuery || []; }).reduce(function (a, b) { return a.concat(b); }, []);
  var domains = pBuiltins.map(senderDomain_).filter(Boolean).concat((senderRows || []).map(function (s) { return s.domain; }).filter(Boolean));
  domains = domains.filter(function (d, i, a) { return a.indexOf(d) === i; });
  var query = GMAIL_BROAD_QUERY.slice(RECEIPT_SEARCH_WINDOW.length + 1);
  if (domains.length) query = '(' + query + ' ' + domains.map(function (d) { return '-from:(' + d + ')'; }).join(' ') + ')';
  query = RECEIPT_SEARCH_WINDOW + ' ' + query;
  var page = client.list(query, null, GMAIL_DRY_RUN_COUNT) || {};
  var ids = (page.ids || []).slice(0, GMAIL_DRY_RUN_COUNT);
  log('G1 待查看邮件试运行：最近 ' + ids.length + ' 封候选；只显示编号后 6 位、日期、网域、金额和处理原因，不写账本。');
  ids.forEach(function (id) {
    try {
      var m = client.get(id), from = parseFromHeader(m.from), at = Number(m.internalDate), subject = normalizeReceiptText(m.subject || '');
      var body = m.html ? htmlToText(m.html) : normalizeReceiptText(m.text || '');
      var cents = genericTotal_(body), reason = genericReceiptLike_(subject) ? 'UNLISTED' : 'NOT_RECEIPT_LIKE';
      log('…' + String(id).slice(-6) + ' | ' + (at ? localNY(new Date(at)).replace('T', ' ') : '?') + ' | ' + (from.domain || '?') +
        ' | ' + (cents === null ? '未读到金额' : formatCents(cents) + ' USD') + ' | ' + reason);
    } catch (e) { log('…' + String(id).slice(-6) + ' | 读取失败：' + gmailErrorCode(e)); }
  });
  return { count: ids.length, writes: 0 };
}

// ---------------- 状态（spec 6.7） ----------------

function whenLocal_(iso) {
  return iso ? localNY(iso) : null;
}

/**
 * 首页和“我的 → 外卖收据自动记账”显示的状态。enabledAt = 开启时间（脚本属性，未开启为 null）。
 * 未开启：不报错、不显示警告（功能关闭不是错误）。warnings（红色提示）：心跳超时、最近一轮运行失败或读取次数异常。
 */
function svcGmailStatus(repo, now, enabledAt, platforms) {
  platforms = platforms || receiptPlatforms();
  var view = { enabled: !!enabledAt, ready: gmailTablesReady_(repo), last_run_local: null, last_success_local: null,
    stale: false, error: null, platforms: [], pending: [], pending_count: 0, warnings: [] };
  view.pending = pendingMailRows_(repo).sort(function (a, b) { return a.received_at < b.received_at ? 1 : -1; }).map(function (r) {
    return {
      id: r.message_id,
      platforms: String(r.platforms || '').split(',').filter(Boolean).map(function (pid) { return receiptPlatformName(pid, platforms); }).join('／'),
      date_local: r.received_at ? localNY(r.received_at) : null,
      sender_domain: r.sender_domain || null,
      amount_cents: typeof r.amount_cents === 'number' ? r.amount_cents : null,
      reason: r.reason,
      link: gmailMessageLink(r.message_id)
    };
  });
  view.pending_count = view.pending.length;
  if (!view.enabled) return view;
  var main = channelStatusRow_(repo, 'gmail');
  if (main) {
    view.last_run_local = whenLocal_(main.last_run_at);
    view.last_success_local = whenLocal_(main.last_success_at);
    if (main.last_error_at && (!main.last_success_at || main.last_error_at >= main.last_success_at)) {
      view.error = { code: main.last_error_code, text: main.last_error_text, local: localNY(main.last_error_at) };
    }
  }
  var ref = Math.max(main && main.last_run_at ? Date.parse(main.last_run_at) : 0, Date.parse(enabledAt) || 0);
  view.stale = now.getTime() - ref > GMAIL_HEARTBEAT_MS;
  var issueSince = new Date(now.getTime() - GMAIL_ISSUE_SHOW_DAYS * DAY_MS).toISOString();
  var pendingByPlatform = {};
  pendingMailRows_(repo).forEach(function (r) {
    String(r.platforms || '').split(',').forEach(function (pid) { pendingByPlatform[pid] = (pendingByPlatform[pid] || 0) + 1; });
  });
  view.platforms = platforms.map(function (p) {
    var row = channelStatusRow_(repo, 'gmail:' + p.id);
    var active = receiptPlatformActive(p);
    return {
      id: p.id, name: p.displayName, active: active,
      support_status: p.support_status, support_label: active ? RECEIPT_SUPPORT_LABEL[p.support_status] || p.support_status : '已关闭',
      last_entry_local: row ? whenLocal_(row.last_entry_at) : null,
      last_latency_min: row && typeof row.last_latency_sec === 'number' ? Math.round(row.last_latency_sec / 60) : null,
      issue: row && row.last_error_at && row.last_error_at >= issueSince
        ? { code: row.last_error_code, text: row.last_error_text, local: localNY(row.last_error_at) } : null,
      uncertain_count: pendingByPlatform[p.id] || 0
    };
  });
  if (!view.ready) view.warnings.push('外卖收据自动记账需要先在脚本编辑器里重新运行一次 setupLedger');
  else if (view.stale) view.warnings.push('外卖收据自动记账可能已停止（超过 20 分钟没有运行），请到“我的 → 外卖收据自动记账”查看');
  if (view.error) view.warnings.push('外卖收据自动记账：' + view.error.text);
  return view;
}
