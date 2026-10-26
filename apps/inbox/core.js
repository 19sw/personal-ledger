/**
 * Apple Pay 收件口（项目 I）的处理规则（spec 5.1 第 3 步、5.3）。纯逻辑：不直接碰 Google 服务，
 * 所有读写都通过 env 传进来（正式运行时由 inbox.js 提供，测试时由内存假实现提供）。
 *
 * 这个项目对任何人公开（无需登录），所以：
 *   - 只做一件事：口令正确时，往「收件箱」的 inbox 工作表追加一行；
 *   - 返回值只有 {ok, reason} 两个字段，绝不返回表格里的任何内容；
 *   - 绝不把请求正文、口令或错误详情写进日志（V8 的 JSON 解析错误信息里会带正文片段）。
 */

var INBOX_SHEET_NAME = 'inbox';
/** inbox 工作表的列（spec 4.3）。项目 M 的 core/inbox.js 有一份相同的清单，测试会检查两者一致。 */
var INBOX_COLUMNS = ['row_type', 'received_at', 'event_id', 'amount_text', 'merchant_text', 'occurred_at_text',
  'shortcut_version', 'rejected_count'];

var INGEST_MAX_BODY_BYTES = 4096;     // 正文超过 4 KB 直接拒绝
var INGEST_TEXT_MAX = 200;            // 文本字段截断到 200 个字符
var INGEST_EVENT_ID_MAX = 100;        // event_id 超长时拒绝（截断会把不同的触发变成同一个）
var INGEST_VERSION_MAX = 20;
var INGEST_TOKEN_MIN_LENGTH = 24;     // 脚本属性中的口令短于这个长度时视为“没有设置”，一律拒绝
var INGEST_WINDOW_ROWS = 60;          // 限流只看最后 60 行（30 条交易 + 24 条标记 = 54 < 60）
var INGEST_LIMIT_HOUR = 10;           // 最近 1 小时已有 10 笔 → 第 11 笔被拒
var INGEST_LIMIT_DAY = 30;            // 最近 24 小时已有 30 笔 → 第 31 笔被拒
var INGEST_LOCK_WAIT_MS = 2000;
var INGEST_HOUR_MS = 3600000;

/** 字符串按 UTF-8 编码后的字节数（不依赖 Utilities，方便在 Node 中测试）。 */
function utf8ByteLength_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * 固定时间比较：比较所用的时间只取决于“正确口令”的长度，不取决于第几个字符开始不同，
 * 防止有人通过测量响应时间一位一位猜口令。
 */
function safeEqual_(given, expected) {
  var a = String(given), b = String(expected);
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    diff |= ca ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 把一个字段整理成安全的短文字：只接受文字或数字；去掉控制字符；截断到 max 个字符。其他类型一律当作空。 */
function cleanIngestText_(v, max) {
  if (typeof v === 'number' && isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  var s = v.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/**
 * 写进表格前的处理：非空文字一律在前面加一个英文单引号，表格就把它当纯文字保存（单引号本身不算内容）。
 * 这样以 = + - @ 开头的内容不会被当作公式执行，像日期或数字的文字也不会被表格自动改写（spec 5.3）。
 */
function sheetText_(s) {
  return s === '' ? '' : "'" + s;
}

/** 表格中的 received_at（正常是 ISO 文字；万一被改成日期也能读）→ 毫秒；读不出时为 NaN。 */
function cellTimeMs_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v === null || v === undefined) return NaN;
  return Date.parse(String(v));
}

/**
 * 解析请求正文，返回 {ok:true, fields} 或 {ok:false, reason}。口令在这里先不比较（由 ingest_ 比较）。
 */
function parseIngestBody_(contents) {
  if (typeof contents !== 'string' || contents === '') return { ok: false, reason: 'bad_request' };
  // 字符数已超过上限时字节数一定更多，直接拒绝，不必逐字计算
  if (contents.length > INGEST_MAX_BODY_BYTES || utf8ByteLength_(contents) > INGEST_MAX_BODY_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  var body;
  try {
    body = JSON.parse(contents);
  } catch (e) {
    return { ok: false, reason: 'bad_request' };   // 不记录错误信息：其中可能带有正文片段
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_request' };
  return { ok: true, body: body };
}

/** 检查字段（口令正确之后才调用）。event_id 必须有、且不超过 100 个字符；其余字段截断到 200 个字符。 */
function ingestFields_(body) {
  var rawId = body.event_id;
  if (typeof rawId === 'number' && isFinite(rawId)) rawId = String(rawId);
  if (typeof rawId !== 'string') return { ok: false, reason: 'bad_request' };
  var eventId = rawId.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (eventId === '' || eventId.length > INGEST_EVENT_ID_MAX) return { ok: false, reason: 'bad_request' };
  return {
    ok: true,
    fields: {
      event_id: eventId,
      amount_text: cleanIngestText_(body.amount_text, INGEST_TEXT_MAX),
      merchant_text: cleanIngestText_(body.merchant_text, INGEST_TEXT_MAX),
      occurred_at_text: cleanIngestText_(body.occurred_at_text, INGEST_TEXT_MAX),
      shortcut_version: cleanIngestText_(body.shortcut_version, INGEST_VERSION_MAX)
    }
  };
}

/**
 * 限流判断（spec 5.3）。windowRows = 最后 60 行（[{row_index, row_type, received_at, event_id, rejected_count}]）。
 * - 只统计 row_type = txn 的行；时间一律用项目 I 写入时的服务器时间 received_at，不看请求里的 occurred_at_text；
 * - “最近 1 小时” = received_at 晚于 now − 1 小时（恰好 1 小时前的行不算）；24 小时同理；
 * - 同一个 event_id 已经在窗口里 → duplicate（快捷指令重试，不再写第二行，也不再占用名额）。
 * 返回 {duplicate, limited, n1, n24}。
 */
function decideIngest_(windowRows, nowMs, eventId) {
  var n1 = 0, n24 = 0, duplicate = false;
  windowRows.forEach(function (r) {
    if (r.row_type !== 'txn') return;
    if (r.event_id === eventId) duplicate = true;
    var t = cellTimeMs_(r.received_at);
    if (isNaN(t)) return;
    if (t > nowMs - INGEST_HOUR_MS) n1++;
    if (t > nowMs - 24 * INGEST_HOUR_MS) n24++;
  });
  return { duplicate: duplicate, limited: n1 >= INGEST_LIMIT_HOUR || n24 >= INGEST_LIMIT_DAY, n1: n1, n24: n24 };
}

/**
 * 被限流时怎样留下标记（spec 5.3）：最近 1 小时内已有标记行 → 在那一行上把被拒次数加 1；否则新写一条标记行。
 * 因此标记行每小时最多一条。返回 {update: {row_index, received_at_ms, count}} 或 {append: true}。
 */
function planRateLimitMarker_(windowRows, nowMs) {
  var latest = null;
  windowRows.forEach(function (r) {
    if (r.row_type !== 'rate_limited') return;
    var t = cellTimeMs_(r.received_at);
    if (isNaN(t) || !(t > nowMs - INGEST_HOUR_MS)) return;
    if (!latest || t >= latest.t) latest = { r: r, t: t };
  });
  if (!latest) return { append: true };
  var count = Number(latest.r.rejected_count);
  if (!isFinite(count) || count < 0) count = 0;
  return { update: { row_index: latest.r.row_index, received_at_ms: latest.t, count: Math.floor(count) + 1 } };
}

function txnRowValues_(nowIso, f) {
  return [sheetText_('txn'), sheetText_(nowIso), sheetText_(f.event_id), sheetText_(f.amount_text),
    sheetText_(f.merchant_text), sheetText_(f.occurred_at_text), sheetText_(f.shortcut_version), ''];
}

function markerRowValues_(nowIso) {
  return [sheetText_('rate_limited'), sheetText_(nowIso), '', '', '', '', '', 1];
}

/**
 * 处理一次投递。contents = 请求正文（文字）。env 提供：
 *   now()                  当前时间（Date）
 *   expectedToken()        脚本属性 INGEST_TOKEN（可能为空）
 *   tryLock(ms) / releaseLock()
 *   sheetReady()           inbox 工作表是否存在且表头正确
 *   readWindow(n)          最后 n 行（不含表头）[{row_index, row_type, received_at, event_id, rejected_count}]
 *   appendRow(values)
 *   updateMarker(row_index, received_at_ms, count) → true（已更新）/ false（那一行已经变了，没写）
 * 返回 {ok:true} 或 {ok:false, reason}，reason ∈ too_large / bad_request / unauthorized / busy / rate_limited / not_ready。
 * 顺序很重要：大小 → 解析 → 口令（错误时什么都不读、不写，也不计入限流）→ 字段 → 锁 → 去重 → 限流 → 写入。
 */
function ingest_(contents, env) {
  var parsed = parseIngestBody_(contents);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  var expected = env.expectedToken();
  if (typeof expected !== 'string' || expected.length < INGEST_TOKEN_MIN_LENGTH) {
    console.warn('收件口：脚本属性 INGEST_TOKEN 没有设置或太短，已拒绝请求');
    return { ok: false, reason: 'unauthorized' };
  }
  var token = parsed.body.token;
  if (typeof token !== 'string' || !safeEqual_(token, expected)) return { ok: false, reason: 'unauthorized' };

  var checked = ingestFields_(parsed.body);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  if (!env.tryLock(INGEST_LOCK_WAIT_MS)) return { ok: false, reason: 'busy' };
  try {
    if (!env.sheetReady()) {
      console.warn('收件口：缺少 inbox 工作表或表头不对，请在脚本编辑器中运行 setupInbox');
      return { ok: false, reason: 'not_ready' };
    }
    var now = env.now();
    var nowMs = now.getTime();
    var nowIso = now.toISOString();
    var rows = env.readWindow(INGEST_WINDOW_ROWS);
    var d = decideIngest_(rows, nowMs, checked.fields.event_id);
    if (d.duplicate) return { ok: true };
    if (d.limited) {
      var plan = planRateLimitMarker_(rows, nowMs);
      var updated = plan.update && env.updateMarker(plan.update.row_index, plan.update.received_at_ms, plan.update.count);
      if (!updated) env.appendRow(markerRowValues_(nowIso));
      return { ok: false, reason: 'rate_limited' };
    }
    env.appendRow(txnRowValues_(nowIso, checked.fields));
    return { ok: true };
  } finally {
    env.releaseLock();
  }
}
