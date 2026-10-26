/**
 * 把「账本」Google 表格包装成 service.js 需要的 repo 接口（list / insert / update / removeByKeys）。
 *
 * 防止表格“自作聪明”：Google 表格会把 '2026-01' 这类文字自动变成日期、把 '=…' 当成公式。
 * 所以写入文字时一律在前面加一个英文单引号 '，表格会把它当作纯文字保存（单引号本身不算内容）。
 * 读出时再按列类型还原（空格子 → null）。
 */

function sheetRepo_(ss) {
  var cache = {};

  function sheetOf(table) {
    var sh = ss.getSheetByName(table);
    if (!sh) throw new Error('缺少工作表 ' + table + '，请先运行 setupLedger');
    return sh;
  }

  function load(table) {
    if (cache[table]) return cache[table];
    var sh = sheetOf(table);
    var cols = LEDGER_SCHEMA[table].columns;
    var last = sh.getLastRow();
    var rows = [];
    if (last >= 2) {
      var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
      values.forEach(function (r) {
        var obj = {};
        cols.forEach(function (c, i) { obj[c[0]] = decodeCell_(c[1], r[i]); });
        rows.push(obj);
      });
    }
    cache[table] = rows;
    return rows;
  }

  function rowIndexOf(table, keyValue) {
    var key = LEDGER_SCHEMA[table].key;
    var rows = load(table);
    for (var i = 0; i < rows.length; i++) if (rows[i][key] === keyValue) return i;
    return -1;
  }

  function encodeRow(table, obj) {
    return LEDGER_SCHEMA[table].columns.map(function (c) { return encodeCell_(c[1], obj[c[0]]); });
  }

  return {
    /** 这张工作表是否存在（切片 1B 的新表在重新运行 setupLedger 之前不存在） */
    has: function (table) {
      return !!ss.getSheetByName(table);
    },
    list: function (table) {
      return load(table).map(function (r) { return Object.assign({}, r); });
    },
    insert: function (table, obj) {
      var rows = load(table);
      var clean = {};
      LEDGER_SCHEMA[table].columns.forEach(function (c) { clean[c[0]] = obj[c[0]] === undefined ? null : obj[c[0]]; });
      sheetOf(table).appendRow(encodeRow(table, clean));
      rows.push(clean);
    },
    update: function (table, keyValue, patch) {
      var i = rowIndexOf(table, keyValue);
      if (i < 0) throw new Error('找不到记录 ' + table + ':' + keyValue);
      var merged = Object.assign({}, load(table)[i], patch);
      sheetOf(table).getRange(i + 2, 1, 1, LEDGER_SCHEMA[table].columns.length).setValues([encodeRow(table, merged)]);
      load(table)[i] = merged;
    },
    removeByKeys: function (table, keys) {
      var key = LEDGER_SCHEMA[table].key;
      var wanted = {};
      keys.forEach(function (k) { wanted[k] = true; });
      var rows = load(table);
      var sh = sheetOf(table);
      // 从下往上删，行号才不会错位
      for (var i = rows.length - 1; i >= 0; i--) {
        if (wanted[rows[i][key]]) {
          sh.deleteRow(i + 2);
          rows.splice(i, 1);
        }
      }
    }
  };
}

function encodeCell_(type, v) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'int') {
    if (typeof v !== 'number' || Math.floor(v) !== v) throw new Error('整数列写入了非整数：' + v);
    return v;
  }
  if (type === 'bool') return v === true;
  return "'" + String(v);
}

function decodeCell_(type, v) {
  if (v === '' || v === null || v === undefined) return type === 'bool' ? false : null;
  if (type === 'int') {
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) throw new Error('表格中有无法识别的金额：' + v);
    return n;
  }
  if (type === 'bool') return v === true || String(v).toUpperCase() === 'TRUE';
  if (v instanceof Date) return v.toISOString(); // 不应出现；万一被表格改成了日期，尽量还原
  return String(v);
}

/** 创建缺少的工作表并写入表头；已有表头与定义不一致时停止，避免写错列。 */
function ensureLedgerSheets_(ss) {
  Object.keys(LEDGER_SCHEMA).forEach(function (table) {
    var names = schemaColumnNames(table);
    var sh = ss.getSheetByName(table) || ss.insertSheet(table);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, names.length).setValues([names]);
      sh.setFrozenRows(1);
      return;
    }
    var header = sh.getRange(1, 1, 1, names.length).getValues()[0].map(String);
    var existing = header.filter(function (h) { return h !== ''; });
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] !== names[i]) throw new Error('工作表 ' + table + ' 的第 ' + (i + 1) + ' 列应为 ' + names[i] + '，实际是 ' + existing[i]);
    }
    if (existing.length < names.length) {
      // 新版本追加的列：只在表头末尾补上，不改动已有数据
      sh.getRange(1, existing.length + 1, 1, names.length - existing.length).setValues([names.slice(existing.length)]);
    }
  });
}

/**
 * 「收件箱」表格（项目 I 写入，项目 M 只读 + 每日清理旧行，spec 4.3）。
 * 只通过脚本属性 INBOX_SPREADSHEET_ID 中的表格 ID 打开这一张表；ID 不写进代码和日志。
 * 出错时抛出带错误代码（inboxCode）的错误，调用方只记录代码。
 */
function inboxRepo_(spreadsheetId) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (e) {
    throw inboxError_('INBOX_OPEN_FAILED');
  }
  var sh = ss && ss.getSheetByName(INBOX_SHEET_NAME);
  if (!sh) throw inboxError_('INBOX_SHEET_MISSING');

  function checkHeader() {
    if (sh.getLastRow() < 1) throw inboxError_('INBOX_HEADER_MISMATCH');
    var header = sh.getRange(1, 1, 1, INBOX_COLUMNS.length).getValues()[0].map(String);
    INBOX_COLUMNS.forEach(function (c, i) { if (header[i] !== c) throw inboxError_('INBOX_HEADER_MISMATCH'); });
  }

  return {
    /** 全部数据行 → [{row_index, row_type, received_at(ISO), event_id, amount_text, merchant_text, occurred_at_text, shortcut_version, rejected_count}] */
    list: function () {
      checkHeader();
      var last = sh.getLastRow();
      if (last < 2) return [];
      var values = sh.getRange(2, 1, last - 1, INBOX_COLUMNS.length).getValues();
      return values.map(function (r, i) {
        var obj = { row_index: i + 2 };
        INBOX_COLUMNS.forEach(function (c, j) {
          var v = r[j];
          if (c === 'rejected_count') obj[c] = v === '' || v === null || v === undefined ? null : Number(v);
          else if (v instanceof Date) obj[c] = v.toISOString();      // 万一被表格改成了日期，尽量还原
          else obj[c] = v === null || v === undefined ? '' : String(v);
        });
        return obj;
      });
    },
    /** 删除指定行号（从下往上，连续的几行一次删除，行号不会错位）。 */
    removeRows: function (rowIndexes) {
      var sorted = rowIndexes.slice().sort(function (a, b) { return b - a; });
      var i = 0;
      while (i < sorted.length) {
        var bottom = sorted[i], top = bottom;
        while (i + 1 < sorted.length && sorted[i + 1] === top - 1) { i++; top = sorted[i]; }
        sh.deleteRows(top, bottom - top + 1);
        i++;
      }
    }
  };
}
