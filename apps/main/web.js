/**
 * 网页入口与给前端调用的函数（google.script.run）。
 * - 名字以 api_ 开头的函数供网页调用；以 _ 结尾的函数是内部函数，网页无法调用。
 * - 所有写操作都在脚本锁里执行，防止和定时任务同时写账本（spec 3、R10）。
 * - 部署设置见 appsscript.json：只有你本人能打开（MYSELF），以你的身份运行。
 */

function doGet() {
  return HtmlService.createTemplateFromFile('ui/index')
    .evaluate()
    .setTitle('记账')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/** 在 HTML 模板里引入其他文件：<?!= include('ui/style') ?> */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 打开「账本」表格：优先使用脚本属性 LEDGER_SPREADSHEET_ID，否则使用脚本绑定的表格。 */
function openLedger_() {
  var id = PropertiesService.getScriptProperties().getProperty('LEDGER_SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('找不到账本表格：请把脚本绑定到「账本」，或在脚本属性中设置 LEDGER_SPREADSHEET_ID');
  return ss;
}

function newId_() {
  return Utilities.getUuid();
}

function readOnly_(fn) {
  try {
    return fn(sheetRepo_(openLedger_()), new Date());
  } catch (e) {
    if (!e.userError) console.error(e && e.stack ? e.stack : e);
    throw e;
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw UserError('系统正忙，请稍后再试');
  try {
    return fn(sheetRepo_(openLedger_()), new Date());
  } catch (e) {
    if (!e.userError) console.error(e && e.stack ? e.stack : e);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ---- 供网页调用 ----

/**
 * 小助手规则（spec 7A.3）：每次写入账目、修改预算和打开网页时，在脚本锁内运行一次。
 * 规则出错只记日志，不影响刚才的保存结果（否则你会以为没保存成功而再记一次）。
 * 小助手的工作表还不存在时，svcRunAssistantRules 直接跳过，不写也不建表。
 */
function runAssistantRules_(repo, now) {
  try {
    svcRunAssistantRules(repo, now, newId_);
  } catch (e) {
    console.error('小助手规则运行失败：' + (e && e.stack ? e.stack : e));
  }
}

/** 写操作 + 之后运行一次小助手规则（同一把锁内）。 */
function withLockAndRules_(fn) {
  return withLock_(function (repo, now) {
    var result = fn(repo, now);
    runAssistantRules_(repo, now);
    return result;
  });
}

// ---- Apple Pay 收件箱（切片 3，spec 5.1 第 4 步） ----

/** 「收件箱」表格的 ID：脚本属性 INBOX_SPREADSHEET_ID（由你本人填写）。没有设置 = Apple Pay 自动记账未开启。 */
function inboxSpreadsheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty('INBOX_SPREADSHEET_ID');
  return id && String(id).trim() ? String(id).trim() : null;
}

var BOOTSTRAP_INBOX_THROTTLE_MS = 15000;   // 打开网页时：15 秒内刚成功整理过就不再整理（定时任务每 5 分钟照常整理）

/**
 * 整理收件箱，任何错误都不往外抛（打开网页、定时任务都不能因为收件箱出问题而失败）。
 * 只记录错误代码（不记录错误信息：其中可能含表格 ID）。在脚本锁内调用。
 * 返回 {configured, created, markers_changed}。
 */
function processInboxSafe_(repo, now, throttleMs) {
  var out = { configured: false, created: 0, markers_changed: false };
  try {
    var id = inboxSpreadsheetId_();
    if (!id) return out;                         // 没有设置收件箱：功能关闭，不是错误
    out.configured = true;
    if (throttleMs && svcInboxRanRecently_(repo, now, throttleMs)) return out;
    var rows;
    try {
      rows = inboxRepo_(id).list();
    } catch (e) {
      var code = (e && e.inboxCode) || 'INBOX_OPEN_FAILED';
      console.error('读取收件箱失败：' + code);
      svcRecordChannelRun_(repo, 'apple_pay', now, { ok: false, created: 0, error_code: code });
      return out;
    }
    var r;
    try {
      r = svcProcessInbox(repo, rows, now, newId_);
    } catch (e2) {
      var code2 = (e2 && e2.inboxCode) || 'PROCESS_FAILED';
      console.error('整理收件箱失败：' + code2);
      svcRecordChannelRun_(repo, 'apple_pay', now, { ok: false, created: 0, error_code: code2 });
      return out;
    }
    out.created = r.created;
    out.markers_changed = r.markers_changed;
    svcRecordChannelRun_(repo, 'apple_pay', now, { ok: !r.errors, created: r.created, error_code: r.error_code, stale_count: r.stale_count });
  } catch (e3) {
    console.error('收件箱整理出现意外错误：' + (e3 && e3.name ? e3.name : 'Error'));
  }
  return out;
}

function api_bootstrap() {
  return withLock_(function (repo, now) {
    svcSeedDefaultsIfEmpty_(repo);   // 打开网页不改动已有账本；补新类别请重新运行 setupLedger
    var inbox = processInboxSafe_(repo, now, BOOTSTRAP_INBOX_THROTTLE_MS);   // 打开网页时整理一次 Apple Pay 收件箱
    runAssistantRules_(repo, now);   // 打开网页时运行一次规则（结果里带 unread_count，红点用）
    return svcBootstrap(repo, now, inbox.configured, receiptPollingEnabledAt_());   // 外卖收据：只读账本里的状态，不读 Gmail
  });
}
function api_listMonth(month, filter) {
  return readOnly_(function (repo, now) { return svcListMonth(repo, month, filter, now); });
}
function api_getEntry(id) {
  return readOnly_(function (repo) { return svcGetEntry(repo, id); });
}
function api_saveEntry(input) {
  return withLockAndRules_(function (repo, now) {
    if (input && input.pending_message_id) return svcSavePendingMailEntry(repo, input.pending_message_id, input, now, newId_);
    return svcSaveEntry(repo, input, now, newId_);
  });
}
function api_deleteEntry(id) {
  return withLockAndRules_(function (repo, now) { return svcDeleteEntry(repo, id, now); });
}
function api_restoreEntry(id) {
  return withLockAndRules_(function (repo, now) { return svcRestoreEntry(repo, id, now); });
}
// 写（脚本锁内）：“待核对重复”的账目选择“两笔都保留”——记进 dup_dismissed，清除这一组的重复标记（PRD 第 4 节）
function api_keepDuplicates(id) {
  return withLockAndRules_(function (repo, now) { return svcKeepDuplicates(repo, id, now); });
}
// 写（脚本锁内）：D16“待查看邮件”点“已查看”——只写 gmail_pending 这一行的 reviewed_at，不碰账目
function api_markMailReviewed(messageId) {
  return withLockAndRules_(function (repo, now) { return svcMarkMailReviewed(repo, messageId, now); });
}
function api_muteMailSender(messageId) {
  return withLockAndRules_(function (repo, now) { return svcMuteMailSender(repo, messageId, now); });
}
function api_addMailSenderAndRecord(messageId, categoryId) {
  return withLockAndRules_(function (repo, now) { return svcAddSenderAndRecordPending(repo, messageId, categoryId, now, newId_); });
}
function api_listDeleted() {
  return readOnly_(function (repo) { return svcListDeleted(repo); });
}
function api_refundCandidates() {
  return readOnly_(function (repo, now) { return svcRefundCandidates(repo, now); });
}
function api_getReport(month) {
  return readOnly_(function (repo, now) { return svcGetReport(repo, month, now); });
}
function api_addCategory(type, name) {
  return withLock_(function (repo) { return svcAddCategory(repo, type, name, newId_); });
}
function api_archiveCategory(id) {
  return withLock_(function (repo, now) { return svcArchiveCategory(repo, id, now, newId_); });
}
function api_addSource(name) {
  return withLock_(function (repo) { return svcAddSource(repo, name, newId_); });
}
function api_archiveSource(id) {
  return withLock_(function (repo) { return svcArchiveSource(repo, id); });
}

// ---- 预算与账单（切片 1B 的预算部分；小助手另行实现） ----
// 只读：某月预算总览（过去月份只读，显示当时的预算）
function api_getBudgets(month) {
  return readOnly_(function (repo, now) { return svcGetBudgets(repo, month, now); });
}
// 写：设置/修改/取消一项预算。月份由服务器按费城时间决定（只能改当前月），空金额 = 取消
function api_setBudget(scope, amount) {
  return withLockAndRules_(function (repo, now) { return svcSetBudget(repo, scope, amount, now, newId_); });
}
// 写：我的 → 预算提醒比例（50–100）
function api_setBudgetNearPct(pct) {
  return withLockAndRules_(function (repo) { return svcSetBudgetNearPct(repo, pct); });
}
// 只读：月账单（某年每个月的收入/支出/结余）
function api_getMonthBills(year) {
  return readOnly_(function (repo, now) { return svcGetMonthBills(repo, year, now); });
}
// 只读：年账单（每个有账目的年份）
function api_getYearBills() {
  return readOnly_(function (repo, now) { return svcGetYearBills(repo, now); });
}

// ---- 储蓄目标与本月估算 ----
function api_getSavings() {
  return readOnly_(function (repo, now) { return svcGetSavings(repo, now); });
}
function api_saveSavingsGoal(input) {
  return withLockAndRules_(function (repo, now) { return svcSaveSavingsGoal(repo, input, now, newId_); });
}
function api_recordSavingsContribution(input) {
  return withLockAndRules_(function (repo, now) { return svcRecordSavingsContribution(repo, input, now); });
}
function api_saveSavingsEstimates(input) {
  return withLockAndRules_(function (repo, now) { return svcSaveSavingsEstimates(repo, input, now); });
}

// ---- 小助手（spec 7A.3–7A.5，Task 06） ----
// 只读：对话窗口的内容（最近 30 天的消息、5 个问题按钮、未读数）
function api_getAssistant() {
  return readOnly_(function (repo, now) { return svcGetAssistant(repo, now); });
}
// 只读：点问题按钮时即时计算回答（不保存、不产生红点）；只接受注册表里的问题 id
function api_askAssistant(skillId) {
  return readOnly_(function (repo, now) { return svcAskAssistant(repo, skillId, now); });
}

/** 直接生成独立报表文件；只读取账本，不修改账目。独立文件确保 Excel 下载不含其他账本工作表。 */
function api_generateTransactionReport(startDate, endDate, lang) {
  lang = lang === 'en' ? 'en' : 'zh';
  return withLock_(function (repo) {
    var report = svcGenerateTransactionReport(repo, startDate, endDate, lang);
    var title = (lang === 'en' ? 'Transactions_' : '收支明细_') + report.start_date + '_' + report.end_date;
    var output = SpreadsheetApp.create(title);
    var sheet = output.getSheets()[0];
    sheet.setName(lang === 'en' ? 'Transactions' : '交易明细');
    var values = transactionReportSheetValues_(report, lang);
    sheet.getRange(1, 1, values.length, 7).setValues(values);
    sheet.setFrozenRows(4);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#d9eee6');
    sheet.getRange(4, 1, 1, 7).setFontWeight('bold').setBackground('#d9eee6');
    sheet.getRange(1, 1, values.length, 7).setWrap(true);
    sheet.getRange(1, 2, values.length, 5).setNumberFormat('$#,##0.00;[Red]-$#,##0.00');
    sheet.autoResizeColumns(1, 7);
    SpreadsheetApp.flush();
    return {
      start_date: report.start_date,
      end_date: report.end_date,
      transaction_count: report.months.reduce(function (n, m) { return n + m.rows.length; }, 0),
      opening_pending_count: report.opening_pending_count,
      pending_count: report.pending_count,
      spreadsheet_url: output.getUrl(),
      excel_url: output.getUrl().replace(/\/edit(?:#.*)?$/, '/export?format=xlsx')
    };
  });
}

/** 表头与说明文字（lang：'en' 或中文）。 */
var TRANSACTION_REPORT_TEXT_ = {
  zh: { title: '收支明细报表（美元）', range: '日期范围', to: ' 至 ', opening: '期初余额（已知金额）',
    openingWarn: function (n) { return '注意：开始日期之前有 ' + n + ' 笔待补全金额，期初余额不完整'; },
    head: ['月份', '交易说明', '分类', '收入', '支出', '余额', '状态'], budget: '当月预算对比（整月实际）',
    budgetHead: ['项目', '预算', '当月支出', '剩余'], total: '总预算', empty: '所选日期范围内没有交易' },
  en: { title: 'Transaction Report (USD)', range: 'Date range', to: ' to ', opening: 'Opening balance (known amounts)',
    openingWarn: function (n) { return 'Note: ' + n + ' entr' + (n === 1 ? 'y' : 'ies') + ' before the start date ' + (n === 1 ? 'has' : 'have') + ' a missing amount, so the opening balance is incomplete'; },
    head: ['Month', 'Description', 'Category', 'Income', 'Expense', 'Balance', 'Status'], budget: 'Budget vs. actual (full month)',
    budgetHead: ['Item', 'Budget', 'Month spending', 'Remaining'], total: 'Total budget', empty: 'No transactions in the selected date range' }
};

function transactionReportSheetValues_(report, lang) {
  var T = TRANSACTION_REPORT_TEXT_[lang === 'en' ? 'en' : 'zh'];
  var rows = [
    [T.title, '', '', '', '', '', ''],
    [T.range, report.start_date + T.to + report.end_date, '', '', '', '', ''],
    [T.opening, '', '', '', '', report.opening_balance_cents / 100,
      report.opening_pending_count ? T.openingWarn(report.opening_pending_count) : ''],
    T.head.slice()
  ];
  report.months.forEach(function (month) {
    rows.push([month.month, '', '', '', '', '', '']);
    if (month.budget) {
      rows.push([T.budget, '', '', '', '', '', '']);
      rows.push(T.budgetHead.concat(['', '', '']));
      if (month.budget.total) rows.push([T.total, month.budget.total.budget_cents / 100, month.budget.total.actual_cents / 100, month.budget.total.remaining_cents / 100, '', '', '']);
    }
    month.rows.forEach(function (item) {
      rows.push([item.date, transactionReportTextCell_(item.description), transactionReportTextCell_(item.category), transactionReportMoneyCell_(item.income_cents), transactionReportMoneyCell_(item.expense_cents), item.balance_cents / 100, item.status || '']);
    });
  });
  if (!report.months.length) rows.push([T.empty, '', '', '', '', '', '']);
  return rows;
}

function transactionReportMoneyCell_(cents) {
  return cents === null || cents === undefined ? '' : cents / 100;
}

/** Sheets treats a leading = as a formula; quote it so merchant/category text stays literal. */
function transactionReportTextCell_(value) {
  var text = value === null || value === undefined ? '' : String(value);
  return /^[=']/.test(text) ? "'" + text : text;
}
// 写（脚本锁内）：打开对话窗口时把未读消息标为已读（红点消失）；只改 read_at 一列
function api_markAssistantRead() {
  return withLock_(function (repo, now) { return svcMarkAssistantRead(repo, now); });
}
