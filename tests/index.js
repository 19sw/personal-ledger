'use strict';
/**
 * Node 25 的 `node --test tests/` 不会自动展开目录，而是把 tests/ 当作模块加载（即本文件）。
 * 这里按文件名载入全部 *.test.js，因此 `node --test tests/` 与 `npm test` 都会运行全部测试。
 */
const fs = require('node:fs');
const path = require('node:path');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
