'use strict';
/**
 * 公开仓库安全检查（spec 9.5，Task 10）：Apple Pay 的设置文档存在、包含安全提醒，
 * 且文档和代码里没有收件口网址、表格网址或像 ID / 口令的长字符串。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function filesUnder(dir) {
  const out = [];
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else out.push(rel);
  }
  return out;
}

test('Apple Pay 设置文档存在，并写明不要用 iCloud 分享、不要截图“获取 URL 内容”', () => {
  const sc = read('docs/shortcut-setup.md');
  const setup = read('docs/applepay-setup.md');
  for (const doc of [sc, setup]) {
    assert.match(doc, /永远不要用 iCloud 链接分享/);
    assert.match(doc, /截图/);
  }
  assert.match(setup, /INBOX_SPREADSHEET_ID/);
  assert.match(setup, /createIngestToken/);
  assert.match(setup, /D6/);
  assert.match(sc, /"ok":true/);
});

test('邮件账单设置文档说明 Task 12 的 setupLedger、G1、四种待查看操作和暂停步骤', () => {
  const doc = read('docs/gmail-receipts-setup.md');
  for (const must of [/setupLedger/, /dryRunReceipts\('broad'\)/, /请核对/, /enableReceiptPolling/,
    /disableReceiptPolling/, /Uber 打车/, /mail_senders/, /domain/, /金额/, /记这一笔/, /以后自动记/,
    /不再提醒这个商家/, /已查看/, /恢复提醒/, /名单外邮件不会自动入账/]) {
    assert.match(doc, must);
  }
});

test('文档和代码中没有收件口网址、表格网址、邮箱地址；文档中没有像 ID 或口令的长字符串', () => {
  const files = ['docs/shortcut-setup.md', 'docs/applepay-setup.md', 'docs/setup-guide.md', 'docs/gmail-receipts-setup.md']
    .concat(filesUnder('apps').filter((f) => /\.(js|json|html|example)$/.test(f) && path.basename(f) !== '.clasp.json'));   // 本机的 .clasp.json 不读
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /script\.google\.com\/macros\/s\//, f);
    assert.doesNotMatch(s, /docs\.google\.com\/spreadsheets\/d\//, f);
    assert.doesNotMatch(s, /[A-Za-z0-9._%+-]+@gmail\.com/, f);
  }
  for (const f of ['docs/shortcut-setup.md', 'docs/applepay-setup.md', 'docs/gmail-receipts-setup.md']) {
    assert.doesNotMatch(read(f), /[A-Za-z0-9_-]{25,}/, f + ' 中有像 ID 或口令的长字符串');
  }
});

test('本机的 .clasp.json（含脚本 ID）不被 git 跟踪，并被 .gitignore 覆盖（不读取文件内容）', (t) => {
  const { assertNeverCommitted } = require('./helpers/git');
  for (const f of ['apps/inbox/.clasp.json', 'apps/main/.clasp.json']) {
    const skip = assertNeverCommitted(assert, f);
    if (skip) { t.skip(skip); return; }
  }
});

test('合成样本：测试里的邮件地址只用 example.test 或三个平台的公开域名，不出现真实个人邮箱', () => {
  const files = filesUnder('tests').filter((f) => /\.js$/.test(f));
  for (const f of files) {
    for (const m of read(f).matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      assert.match(m[1], /^(example\.test|doordash\.com|uber\.com|mail\.doordash\.com|notdoordash\.com|example\.com|[a-z0-9-]+\.example)$/,
        f + ' 中的邮件地址 ' + m[0]);
    }
  }
});
