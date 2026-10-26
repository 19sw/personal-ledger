/**
 * 一次性设置与定时任务。
 * 关于“网页能否调用这些函数”：Apps Script 的 google.script.run 可以调用任何不以 _ 结尾的全局函数，
 * 但网页部署为“只有我自己”，只有你本人登录后才能调用。下面的函数都可以安全地重复运行
 * （setupLedger/installTriggers 幂等，dailyCleanup 只清除删除超过 30 天的账目），
 * 写测试数据的 testAddPendingEntry 另有脚本属性开关。tests/ui.test.js 会检查公开函数清单，新增前需要评审。
 * - setupLedger：在脚本编辑器里手动运行一次，创建工作表、默认类别和默认设置（重复运行也安全；
 *   已有账本上重新运行只会补上新工作表、新列、缺少的默认类别和设置，并按已有账目的创建时间补上打卡，不改动已有数据）。
 * - installTriggers：手动运行一次，安装“每日清理”和“每 5 分钟整理 Apple Pay 收件箱”两个定时器
 *   （重复运行会先删除旧的，不会装两份）。
 * - dailyCleanup：由定时器每天凌晨（费城时间）运行，彻底清除删除超过 30 天的账目，删除 90 天前的小助手消息，
 *   并删除「收件箱」中 30 天前的原始行（processed_sources 永不清理）。
 * - processInbox：由定时器每 5 分钟运行，把「收件箱」里新的 Apple Pay 付款整理成账目（没设置收件箱时什么都不做）。
 *   网页也能调用它（只有你本人能打开网页），效果和打开网页时自动整理一样：幂等、在脚本锁内、不返回任何收件箱内容。
 * - 外卖收据（切片 2，docs/gmail-receipts-setup.md）分两阶段开启，installTriggers 不会开启它：
 *   dryRunReceipts('doordash' / 'uber' / 'ubereats')：G1 只读试运行，只在日志里列出最近 10 封的识别结果，不写任何东西；
 *   enableReceiptPolling：核对通过后运行一次，安装每 5 分钟的 pollReceipts 定时器（重复运行不会装两份）；
 *   disableReceiptPolling：停止自动读取（删除定时器）；
 *   pollReceipts：定时器的入口；没有开启时什么都不做。
 */

function setupLedger() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = openLedger_();
    ensureLedgerSheets_(ss);
    var repo = sheetRepo_(ss);
    svcEnsureDefaults(repo);
    svcEnsureSettings(repo);
    var filled = svcBackfillCheckins(repo);   // 按已有账目的创建时间补上打卡（只补缺少的天）
    console.log('账本工作表已就绪' + (filled ? '，补上 ' + filled + ' 天打卡' : ''));
  } finally {
    lock.releaseLock();
  }
}

/**
 * 一次性修复（2026-10-26）：任务 12 的代码曾把 restaurant_key 插在 entries 第 20 列，期间写入的 6 行错位了一格。
 * 在脚本编辑器里手动运行一次。只认下面这 6 个账目编号，并且只有当这一行仍是当时看到的错位样子时才改：
 * - SHIFTED：T（created_at）空、U = V、W 空 → T 填 U 的值，V 清空（恢复创建时间，不再显示为已删除）；
 * - STRAY_W：W（restaurant_key）等于 V（deleted_at）→ 清空 W。
 * 其他行、其他列一律不碰；重复运行时已修好的行会跳过。日志只写行号和结果。
 */
var ENTRY_COLUMN_REPAIRS_20261026 = [
  { id: 'da057c22-cb9d-4b6b-9779-2532d0c45b41', fix: 'STRAY_W' },
  { id: 'daad8b08-e8da-4909-88b3-421e86245d8f', fix: 'SHIFTED' },
  { id: '2b557841-240d-4535-8d6a-98320a400933', fix: 'SHIFTED' },
  { id: '0153a9e0-4289-42d1-b399-0d17188047f6', fix: 'SHIFTED' },
  { id: '44c6ff26-222f-4cd6-aac9-836337f8411d', fix: 'SHIFTED' },
  { id: '9b425756-86dd-4fa9-bfc5-cc9ca3d0ff1e', fix: 'SHIFTED' }
];

function repairEntryColumns20261026() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = openLedger_().getSheetByName('entries');
    var names = schemaColumnNames('entries');
    var header = sh.getRange(1, 1, 1, names.length).getValues()[0].map(String);
    if (header.join(',') !== names.join(',')) throw new Error('entries 表头和程序不一致，请先运行 setupLedger；什么都没改');
    var col = function (n) { return names.indexOf(n); };
    var C = col('created_at'), U = col('updated_at'), D = col('deleted_at'), R = col('restaurant_key'), CH = col('channel');
    var last = sh.getLastRow();
    var values = last >= 2 ? sh.getRange(2, 1, last - 1, names.length).getValues() : [];
    var str = function (v) { return v === null || v === undefined ? '' : String(v); };
    var out = { fixed: 0, skipped: 0, missing: 0 };
    ENTRY_COLUMN_REPAIRS_20261026.forEach(function (target) {
      var i = -1;
      for (var k = 0; k < values.length; k++) if (str(values[k][0]) === target.id) { i = k; break; }
      if (i < 0) { out.missing++; console.log('没找到一行（可能已被清理），跳过'); return; }
      var row = values[i].slice(), rowNo = i + 2;
      var ok = target.fix === 'SHIFTED'
        ? str(row[CH]) === 'apple_pay' && str(row[C]) === '' && str(row[U]) !== '' && str(row[U]) === str(row[D]) && str(row[R]) === ''
        : str(row[D]) !== '' && str(row[R]) === str(row[D]);
      if (!ok) { out.skipped++; console.log('第 ' + rowNo + ' 行不是预期的样子（可能已修好），没改'); return; }
      if (target.fix === 'SHIFTED') { row[C] = row[U]; row[D] = ''; } else { row[R] = ''; }
      // 与 store.js 相同：文字前加单引号，避免被表格自动变成日期
      var cells = [C, D, R].sort(function (a, b) { return a - b; });
      var first = cells[0];
      var slice = row.slice(first, cells[cells.length - 1] + 1).map(function (v) { return v === '' ? '' : "'" + str(v); });
      sh.getRange(rowNo, first + 1, 1, slice.length).setValues([slice]);
      out.fixed++;
      console.log('第 ' + rowNo + ' 行已修好（' + target.fix + '）');
    });
    console.log('修复完成：修好 ' + out.fixed + ' 行，跳过 ' + out.skipped + ' 行，没找到 ' + out.missing + ' 行');
    return out;
  } finally {
    lock.releaseLock();
  }
}

// installTriggers 只管理这两个定时器；外卖收据的 pollReceipts 定时器只由 enableReceiptPolling / disableReceiptPolling 管理（两阶段开启）
var MANAGED_TRIGGERS = ['dailyCleanup', 'processInbox'];

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (MANAGED_TRIGGERS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCleanup').timeBased().everyDays(1).atHour(3).inTimezone(LEDGER_TZ).create();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  console.log('已安装每日清理定时器和每 5 分钟整理收件箱的定时器');
}

function dailyCleanup() {
  var result = withLock_(function (repo, now) {
    var r = svcPurgeDeleted(repo, now);                       // 打卡记录不受影响
    r.messages = svcPurgeAssistantMessages(repo, now).purged; // 小助手消息保留 90 天（D11）
    r.inbox = purgeInboxSafe_(now);                           // 收件箱原始行保留 30 天（spec 4.3）
    return r;
  });
  console.log('清理完成，彻底删除 ' + result.purged + ' 笔账目、' + result.messages + ' 条小助手消息、' +
    result.inbox + ' 行收件箱旧记录');
}

/** 删除「收件箱」中 received_at 早于 30 天前的行。没设置收件箱或出错时返回 0（只记录错误代码）。 */
function purgeInboxSafe_(now) {
  try {
    var id = inboxSpreadsheetId_();
    if (!id) return 0;
    var inbox = inboxRepo_(id);
    var rows = selectInboxPurgeRows(inbox.list(), now);
    if (rows.length) inbox.removeRows(rows);
    return rows.length;
  } catch (e) {
    console.error('清理收件箱失败：' + ((e && e.inboxCode) || (e && e.name) || 'Error'));
    return 0;
  }
}

/** 定时任务（每 5 分钟）：整理 Apple Pay 收件箱；有新账目或新的限流情况时运行一次小助手规则。 */
function processInbox() {
  if (!inboxSpreadsheetId_()) return { configured: false, created: 0 };   // 没设置收件箱：不拿锁、不打开账本
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    // 拿不到锁（例如你正在保存）：这次跳过，5 分钟后再整理。不抛错，免得 Google 发“定时任务失败”的邮件
    console.warn('processInbox: LOCK_BUSY');
    return { configured: true, created: 0, skipped: true };
  }
  try {
    var repo = sheetRepo_(openLedger_());
    var now = new Date();
    var out = processInboxSafe_(repo, now, 0);
    if (out.created > 0 || out.markers_changed) runAssistantRules_(repo, now);
    return { configured: out.configured, created: out.created };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 仅用于手机验收（docs/checklist-slice1.md）：在脚本编辑器中手动运行，
 * 为“当前时刻”写入一笔金额为空的测试支出。验收完成后在网页里删除即可。
 *
 * 防护：Apps Script 允许网页调用任何不以 _ 结尾的全局函数（网页只有你本人能打开）。
 * 为避免误写测试数据，只有在脚本属性 ALLOW_TEST_ENTRY 设为 yes 时才执行；验收后请删除这个属性。
 */
function testAddPendingEntry() {
  if (PropertiesService.getScriptProperties().getProperty('ALLOW_TEST_ENTRY') !== 'yes') {
    throw new Error('未开启测试数据：请先在“项目设置 → 脚本属性”中添加 ALLOW_TEST_ENTRY = yes');
  }
  var e = withLockAndRules_(function (repo, now) { return svcInsertTestPending(repo, localNY(now), now, newId_); });
  console.log('已写入测试账目（待补全）：' + e.date_ny);
}

// ---------------- 外卖收据（切片 2，spec 6.4–6.8） ----------------

/**
 * 定时任务（开启后每 5 分钟）：读取外卖平台的新邮件并入账。没有开启时什么都不做（不拿锁、不读 Gmail、不打开账本）。
 * 拿不到锁就跳过本轮；任何错误都只记录错误代码，不抛错。日志只写数量和代码，不写任何邮件内容。
 * 网页也能调用它（只有你本人能打开网页）：效果与定时任务相同，只返回数字和代码。
 */
function pollReceipts() {
  if (!receiptPollingEnabledAt_()) {
    console.log('pollReceipts: OFF');
    return { enabled: false };
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('pollReceipts: LOCK_BUSY');
    return { enabled: true, skipped: true };
  }
  try {
    var repo = sheetRepo_(openLedger_());
    var now = new Date();
    var out;
    try {
      out = svcPollReceipts(repo, gmailClient_(), now, receiptPlatforms(), newId_);
    } catch (e) {
      var code = gmailErrorCode(e);
      console.error('pollReceipts: ' + code);
      svcRecordChannelRun_(repo, 'gmail', now, { ok: false, created: 0, error_code: code });
      return { enabled: true, error_code: code };
    }
    if (out.created || out.flagged || out.pending_added) runAssistantRules_(repo, now);
    console.log('pollReceipts: 列出 ' + out.listed + '，读取 ' + out.read + '，入账 ' + out.created + '，待核对 ' + out.flagged +
      '，待查看 ' + out.pending_added + '，忽略 ' + out.ignored + '，失败 ' + out.errors + (out.error_code ? '，' + out.error_code : '') +
      (out.time_limited ? '，TIME_BUDGET（下一轮继续）' : ''));
    return { enabled: true, listed: out.listed, read: out.read, created: out.created, flagged: out.flagged,
      pending_added: out.pending_added, ignored: out.ignored, errors: out.errors, error_code: out.error_code };
  } catch (e2) {
    console.error('pollReceipts: ' + ((e2 && e2.receiptCode) || (e2 && e2.name) || 'Error'));
    return { enabled: true, error_code: 'UNEXPECTED' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * G1 只读试运行（spec 6.8）。在脚本编辑器里直接选中 dryRunReceipts 点“运行”：平台或待查看邮件试运行均只读；
 * 也可以只看一个平台：dryRunReceipts('doordash') / dryRunReceipts('uber') / dryRunReceipts('ubereats')。
 * 日志里只列出：编号后 6 位、到达时间、发件域名、分类、金额和币种、是否找到订单号、使用了哪个总额标签。
 * 不输出任何正文或主题，不打开账本，不写任何东西，也不需要先开启自动记账。返回每个平台读了几封。
 */
function dryRunReceipts(platformId) {
  var platforms = receiptPlatforms();
  var client = gmailClient_();
  var log = function (line) { console.log(line); };
  if (String(platformId || '').toLowerCase() === 'broad') {
    var repo = sheetRepo_(openLedger_());
    return svcDryRunBroadScan(client, platforms, tableReady_(repo, 'mail_senders') ? repo.list('mail_senders') : [], log);
  }
  var ids = typeof platformId === 'string' && platformId ? [platformId] : platforms.map(function (p) { return p.id; });
  return ids.map(function (id) {
    var r = svcDryRunReceipts(client, id, platforms, log);
    return { platform: r.platform, count: r.count };
  });
}

/**
 * 开启外卖收据自动记账（G1 核对通过后，在脚本编辑器里手动运行一次）：安装每 5 分钟的 pollReceipts 定时器。
 * 重复运行也只有一个定时器。需要先重新运行过 setupLedger（有 gmail_pending 等工作表）。
 */
function enableReceiptPolling() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var repo = sheetRepo_(openLedger_());
    if (!gmailTablesReady_(repo)) throw new Error('请先在脚本编辑器里重新运行一次 setupLedger，再运行 enableReceiptPolling');
    if (!gmailServiceReady_()) throw new Error('没有启用高级 Gmail 服务：请按 docs/gmail-receipts-setup.md 重新上传代码后再试');
    removePollTriggers_();
    ScriptApp.newTrigger('pollReceipts').timeBased().everyMinutes(5).create();
    PropertiesService.getScriptProperties().setProperty(GMAIL_POLLING_PROP, new Date().toISOString());
    console.log('已开启收据邮件自动记账：每 5 分钟读取一次（名单商家自动记账，其他疑似收据待查看）');
  } finally {
    lock.releaseLock();
  }
}

/** 停止外卖收据自动记账：删除定时器、清除开启标记（重复运行也安全）。已入账的账目不变。 */
function disableReceiptPolling() {
  var n = removePollTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(GMAIL_POLLING_PROP);
  console.log('已停止外卖收据自动记账' + (n ? '（删除了 ' + n + ' 个定时器）' : '（本来就没有开启）'));
}
