'use strict';
/**
 * “本机文件永不提交”检查：只问 git 这个路径有没有被跟踪、是否被 .gitignore 覆盖。
 * 不读取、不打印文件内容（例如 apps/inbox/.clasp.json 里有真实的脚本 ID）。本机没有 git 或不在仓库里时跳过。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, stdio: 'ignore' });
}

/** 返回 null 表示检查通过；返回字符串表示应跳过的原因。不通过时直接 assert 失败。 */
function assertNeverCommitted(assert, relPath) {
  const probe = git(['rev-parse', '--is-inside-work-tree']);
  if (probe.error || probe.status !== 0) return '没有 git 或不在 git 仓库中';
  assert.notEqual(git(['ls-files', '--error-unmatch', '--', relPath]).status, 0, relPath + ' 不能被 git 跟踪（不提交）');
  assert.equal(git(['check-ignore', '-q', '--', relPath]).status, 0, relPath + ' 必须被 .gitignore 覆盖');
  return null;
}

module.exports = { assertNeverCommitted };
