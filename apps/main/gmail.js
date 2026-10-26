/**
 * 高级 Gmail 服务（对 Gmail API 的直接调用，spec 6.1）的连接代码。只用 gmail.readonly 权限，不使用 GmailApp。
 * 这里只有以 _ 结尾的内部函数（网页无法调用）；入口函数在 jobs.js。
 *
 * 隐私：读到的邮件只交给 core/receipt_pipeline.js 在内存里处理，这里不打印、不保存任何邮件内容。
 */

/** 脚本属性：外卖收据自动记账的开启时间（ISO）。没有这个属性 = 未开启，pollReceipts 什么都不做。 */
var GMAIL_POLLING_PROP = 'GMAIL_POLLING_ENABLED_AT';

/** 开启时间，未开启（或读不到脚本属性）时为 null。 */
function receiptPollingEnabledAt_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(GMAIL_POLLING_PROP);
    return v && !isNaN(Date.parse(v)) ? String(v) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 正文的 data 字段 → 文字。Gmail API 规定是 base64url 文字；高级服务里也可能是字节数组【未核实】，两种都能处理。
 */
function decodeGmailBody_(data) {
  if (data === null || data === undefined || data === '') return '';
  if (typeof data === 'string') {
    var s = data.replace(/\s+/g, '');
    while (s.length % 4) s += '=';
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
  }
  return Utilities.newBlob(data).getDataAsString('UTF-8');
}

/** 高级 Gmail 服务是否已在 appsscript.json 中启用（没有启用时全局变量 Gmail 不存在）。 */
function gmailServiceReady_() {
  return typeof Gmail !== 'undefined' && Gmail && Gmail.Users && Gmail.Users.Messages;
}

/** receipt_pipeline.js 需要的 client：list(q, pageToken, max) → {ids, nextPageToken}；get(id) → 简化的邮件对象。 */
function gmailClient_() {
  if (!gmailServiceReady_()) throw receiptError_('GMAIL_SERVICE_MISSING');
  return {
    list: function (q, pageToken, max) {
      var opts = { q: q, maxResults: max || GMAIL_PAGE_SIZE };
      if (pageToken) opts.pageToken = pageToken;
      var r = Gmail.Users.Messages.list('me', opts) || {};
      return { ids: (r.messages || []).map(function (m) { return m.id; }), nextPageToken: r.nextPageToken || null };
    },
    get: function (id) {
      return simplifyGmailMessage(Gmail.Users.Messages.get('me', id, { format: 'full' }), decodeGmailBody_);
    }
  };
}

/** 删除所有 pollReceipts 定时器，返回删除的个数。 */
function removePollTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pollReceipts') { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}
