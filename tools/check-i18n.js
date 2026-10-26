'use strict';
/**
 * 英文对照表覆盖检查（spec 8A）：npm run check:i18n
 * 以“影子检查”方式跑全部网页测试（界面仍是中文，测试照常通过），把页面上出现过的每段文字都试着翻成英文，
 * 列出翻不了的文字。测试数据里用户自己输入的内容（商家名、自建类别等）本来就不翻译，在 USER_TEXT 里排除。
 * 有漏翻时退出码为 1：到 apps/main/ui/i18n-en.js.html 补上英文。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USER_TEXT = ['健身房', '健', '兼职收入', '午饭', '咖啡店', '网店', '网络中断', '茶店', '超市', '麦当劳', '小店'];
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-')), 'missing.json');
const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter((f) => /^ui.*\.test\.js$/.test(f)).map((f) => path.join('tests', f));
const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1'].concat(files), {
  cwd: root, env: Object.assign({}, process.env, { I18N_COLLECT: out }), encoding: 'utf8'
});
if (run.status !== 0) {
  console.error(run.stdout.slice(-3000));
  console.error('网页测试没有全部通过，先修好测试再检查翻译。');
  process.exit(1);
}
const missing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const strip = (t) => USER_TEXT.reduce((acc, u) => acc.split(u).join(''), t);
const left = Object.keys(missing).filter((k) => /[㐀-鿿]/.test(strip(k)));
if (left.length) {
  console.log('以下文字在英文对照表里查不到（apps/main/ui/i18n-en.js.html）：');
  left.forEach((k) => console.log('  ' + JSON.stringify(k)));
  process.exit(1);
}
console.log('英文对照表覆盖了网页测试中出现的全部界面文字（用户自己输入的内容除外）。');
