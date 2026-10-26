'use strict';
/**
 * 假的 Google 表格（只实现 store.js 用到的方法），用来测试表格读写代码本身。
 * 模拟了表格的“自动识别”：没有前导单引号的文字，如果像日期或数字，会被变成日期或数字；
 * 前导单引号会让表格按纯文字保存，读出时不含单引号。
 * 注意：这是对 Google 表格行为的模型，真实表格的细节需在切片 0b 中核对。
 */
function coerce(v) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (/^\d{4}-\d{2}(-\d{2})?/.test(v)) return new Date(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'TRUE' || v === 'FALSE') return v === 'TRUE';
  return v;
}

class FakeSheet {
  constructor(name, id = 0) { this.name = name; this.id = id; this.rows = []; this.frozen = 0; }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getSheetId() { return this.id; }
  getLastRow() { return this.rows.length; }
  setFrozenRows(n) { this.frozen = n; }
  autoResizeColumns() { return this; }
  appendRow(values) { this.rows.push(values.map(coerce)); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  deleteRows(r, n) { this.rows.splice(r - 1, n); }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.rows[r - 1 + i] || [];
          const vals = [];
          for (let j = 0; j < nc; j++) vals.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(vals);
        }
        return out;
      },
      setValues(values) {
        if (values.length !== nr || values[0].length !== nc) throw new Error('range size mismatch');
        for (let i = 0; i < nr; i++) {
          while (sheet.rows.length < r + i) sheet.rows.push([]);
          const row = sheet.rows[r - 1 + i];
          for (let j = 0; j < nc; j++) row[c - 1 + j] = coerce(values[i][j]);
        }
        return this;
      },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setWrap() { return this; },
      setNumberFormat() { return this; }
    };
  }
}

class FakeSpreadsheet {
  constructor(id = 'fake-spreadsheet') { this.id = id; this.sheets = {}; this.nextSheetId = 0; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getSheets() { return Object.keys(this.sheets).map((n) => this.sheets[n]); }
  getId() { return this.id; }
  getUrl() { return ['https:', '', 'docs.google.com', 'spreadsheets', 'd', this.id, 'edit'].join('/'); }
  insertSheet(n) { this.sheets[n] = new FakeSheet(n, this.nextSheetId++); return this.sheets[n]; }
  deleteSheet(sheet) { delete this.sheets[sheet.getName()]; }
}

module.exports = { FakeSpreadsheet, FakeSheet, coerce };
