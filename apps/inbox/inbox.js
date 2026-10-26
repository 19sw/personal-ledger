/**
 * Apple Pay 收件口（项目 I）：绑定在「收件箱」表格上的独立谷歌脚本项目（spec 5.1、5.3、6.1）。
 *
 * - 部署为网页应用：任何人无需登录即可访问（ANYONE_ANONYMOUS），以你的身份运行；
 *   权限只有 spreadsheets.currentonly（只能碰绑定的「收件箱」这一张表格，读不到「账本」，也读不到 Gmail）。
 * - 只有 doPost，没有 doGet：别人打开网址看不到任何数据。
 * - 口令保存在脚本属性 INGEST_TOKEN 里（由你本人生成和填写），代码和仓库中只有这个属性名。
 * - setupInbox 只在脚本编辑器里由你手动运行；网页应用只会调用 doPost，网址上无法调用其他函数。
 */

function doPost(e) {
  var result;
  try {
    var contents = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    result = ingest_(contents, inboxEnv_());
  } catch (err) {
    // 只记录错误类型，不记录错误信息（可能含正文或口令片段）
    console.error('收件口：意外错误 ' + (err && err.name ? err.name : 'Error'));
    result = { ok: false, reason: 'error' };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/** 把 Google 服务包装成 core.js 的 ingest_ 需要的 env。表格和锁都在需要时才打开。 */
function inboxEnv_() {
  var lock = null;
  var sheet = null;
  function sh() {
    if (sheet === null) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      sheet = (ss && ss.getSheetByName(INBOX_SHEET_NAME)) || false;
    }
    return sheet;
  }
  return {
    now: function () { return new Date(); },
    expectedToken: function () { return PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN'); },
    tryLock: function (ms) {
      lock = LockService.getScriptLock();
      return lock.tryLock(ms);
    },
    releaseLock: function () { if (lock) lock.releaseLock(); },
    sheetReady: function () {
      var s = sh();
      if (!s || s.getLastRow() < 1) return false;
      var header = s.getRange(1, 1, 1, INBOX_COLUMNS.length).getValues()[0].map(String);
      return INBOX_COLUMNS.every(function (c, i) { return header[i] === c; });
    },
    readWindow: function (n) {
      var s = sh();
      var last = s.getLastRow();
      if (last < 2) return [];
      var start = Math.max(2, last - n + 1);
      var values = s.getRange(start, 1, last - start + 1, INBOX_COLUMNS.length).getValues();
      return values.map(function (r, i) {
        return { row_index: start + i, row_type: String(r[0]), received_at: r[1], event_id: String(r[2]), rejected_count: r[7] };
      });
    },
    appendRow: function (values) { sh().appendRow(values); },
    /**
     * 更新标记行的被拒次数。写之前再读一次这一行，确认它仍是同一条标记（项目 M 的每日清理可能刚删掉上面的旧行，
     * 行号会整体上移）；不一致就不写，由调用方改为新写一条标记行。
     */
    updateMarker: function (rowIndex, receivedAtMs, count) {
      var s = sh();
      if (rowIndex < 2 || rowIndex > s.getLastRow()) return false;
      var r = s.getRange(rowIndex, 1, 1, 2).getValues()[0];
      if (String(r[0]) !== 'rate_limited' || cellTimeMs_(r[1]) !== receivedAtMs) return false;
      s.getRange(rowIndex, INBOX_COLUMNS.length, 1, 1).setValues([[count]]);
      return true;
    }
  };
}

/**
 * 在脚本编辑器里手动运行：生成一个随机口令（64 个字符），直接存进脚本属性 INGEST_TOKEN。
 * - 口令不会显示在日志里；需要填进快捷指令时，到“项目设置 → 脚本属性”里复制。
 * - 已经有口令时不会覆盖（防止误点后快捷指令全部失效）。要换口令：先在脚本属性里删掉 INGEST_TOKEN，再运行一次。
 */
function createIngestToken() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INGEST_TOKEN')) {
    console.log('已经有口令了，没有改动。要换新口令，请先在“项目设置 → 脚本属性”中删除 INGEST_TOKEN，再运行一次。');
    return;
  }
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('INGEST_TOKEN', token);
  console.log('已生成新口令并保存到脚本属性 INGEST_TOKEN（这里不显示口令）。');
}

/**
 * 在脚本编辑器里手动运行一次：建好 inbox 工作表和表头（重复运行也安全，不改动已有数据）。
 * 同时告诉你口令属性是否已经设置（只说“有/没有”，不显示口令）。
 */
function setupInbox() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var s = ss.getSheetByName(INBOX_SHEET_NAME) || ss.insertSheet(INBOX_SHEET_NAME);
  if (s.getLastRow() === 0) {
    s.getRange(1, 1, 1, INBOX_COLUMNS.length).setValues([INBOX_COLUMNS]);
    s.setFrozenRows(1);
  } else {
    var header = s.getRange(1, 1, 1, INBOX_COLUMNS.length).getValues()[0].map(String);
    INBOX_COLUMNS.forEach(function (c, i) {
      if (header[i] !== c) throw new Error('inbox 工作表第 ' + (i + 1) + ' 列应为 ' + c + '，实际是 ' + header[i] + '。请不要手动修改这张表');
    });
  }
  var token = PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN');
  console.log('inbox 工作表已就绪。口令 INGEST_TOKEN：' +
    (token && token.length >= INGEST_TOKEN_MIN_LENGTH ? '已设置' : '还没有设置（或少于 ' + INGEST_TOKEN_MIN_LENGTH + ' 个字符），收件口会拒绝所有请求'));
}
