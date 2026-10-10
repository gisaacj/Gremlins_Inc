// =============================================================
// 推送脚本：一次把当前分支推到 GitHub 与 Gitee
//
// 背景：这个项目有两处远端
//   GitHub : gisaacj/Gremlins_Inc   （分支 master）
//   Gitee  : gisaacj/Gremlins_Inc2  （分支 main —— 注意名字不同！）
// 而且 GitHub 间歇性 443 超时/502，Gitee 稳定。所以两边都要推，
// 但允许某一边失败而不影响另一边。
//
// 凭据：
//   Gitee 的凭据存在 **Windows 凭据管理器** 里
//   （target = `git:https://gisaacj@gitee.com`）。
//   但仓库没配 `credential.helper`，git 默认不会去读它 ——
//   所以本脚本显式带 `-c credential.helper=wincred`。
//   GitHub 用环境变量 GH_TOKEN，或走 tools/push-via-api.mjs 的 API 通道兜底。
//
// 用法:
//   node tools/push-both.mjs                 # 推当前分支
//   node tools/push-both.mjs --dry-run
// =============================================================
import { execFileSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const CWD = process.cwd();

const REMOTES = [
  {
    name: 'github',
    url: 'https://github.com/gisaacj/Gremlins_Inc.git',
    branch: 'master',
    // GitHub 走 token 内联比较省事；也可换用 API 通道
    auth: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  },
  {
    name: 'gitee',
    url: 'https://gitee.com/gisaacj/Gremlins_Inc2.git',
    branch: 'main',            // ⚠️ Gitee 的默认分支叫 main，不是 master
    helper: 'wincred',         // 从 Windows 凭据管理器取凭据
  },
];

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: CWD, encoding: 'utf8', stdio: 'pipe', ...opts });

const head = git(['rev-parse', 'HEAD']).trim();
const subject = git(['log', '-1', '--pretty=%s']).trim();
console.log(`待推送提交: ${head.slice(0, 7)}  ${subject}\n`);

const results = [];
for (const r of REMOTES) {
  const url = r.auth
    ? r.url.replace('https://', `https://${r.auth}@`)
    : r.url;
  const args = ['push'];
  if (r.helper) args.push('-c', `credential.helper=${r.helper}`);
  args.push(url, `HEAD:${r.branch}`, '--force');
  if (DRY) args.push('--dry-run');

  process.stdout.write(`→ ${r.name} (${r.branch}) ... `);
  try {
    const out = git(args, { stdio: 'pipe' }).toString();
    const tail = out.split('\n').filter(Boolean).slice(-1)[0] ?? '';
    console.log(`✓ ${tail.replace(/https:\/\/[^@/]*@/, 'https://***@')}`);
    results.push([r.name, true, '']);
  } catch (e) {
    const msg = (e.stderr?.toString() || e.message || '').split('\n')
      .filter((l) => l && !/SECURITY WARNING|TLS certificate|HTTPS connections|^warning: \|/.test(l))
      .slice(0, 2).join(' | ');
    console.log(`✗ ${msg}`);
    results.push([r.name, false, msg]);
  }
}

console.log('\n=== 汇总 ===');
for (const [name, ok, msg] of results) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : '  — ' + msg}`);
}
const failed = results.filter((r) => !r[1]);
if (failed.length) {
  console.log('\n提示：GitHub 失败时可改用 API 通道：');
  console.log('  node --use-system-ca tools/push-via-api.mjs \\');
  console.log('    --token <PAT> --repo gisaacj/Gremlins_Inc --branch master \\');
  console.log('    --base <远端当前sha> --cwd . --single');
}
process.exit(failed.length ? 1 : 0);
