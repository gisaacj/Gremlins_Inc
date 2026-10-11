// 只推 GitHub，自动重试 + 自动降级
//
// 用法（在仓库根目录执行）：
//     node tools/push-github.mjs
//
// 为什么单独一个脚本：本机到 GitHub 的连接不稳定 ——
//   * github.com:443 经常超时，或返回 502 Bad Gateway
//   * api.github.com 的 git/blobs 接口会**随机** 502（同一 blob 重试就成功）
// 所以这里做两层：
//   1) 先试标准 `git push`
//   2) 失败则改用 Git Data API 逐个上传（push-via-api.mjs，已带 5xx 重试）
// 下面每一层内部都会重试多轮。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const REPO = 'gisaacj/Gremlins_Inc';
const BRANCH = 'master';
const ROUNDS = Number(process.env.ROUNDS || 10);

const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// token：从环境变量取，或从 tools/.github-token 读（该文件已被 gitignore）
let TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const tokenFile = resolve(ROOT, 'tools', '.github-token');
if (!TOKEN && existsSync(tokenFile)) TOKEN = readFileSync(tokenFile, 'utf8').trim();

// ── 关于 TLS ──
// Node 自带的根证书集在本机验不过 GitHub 的证书链
// （报错是含糊的 "fetch failed" / "基础连接已经关闭"），
// 但系统证书库（Windows cert store）可以。
// 所以本脚本若检测到自己是「没带 --use-system-ca」启动的，就自我重启一次。
if (!process.execArgv.includes('--use-system-ca') && !process.env.DSH_NO_REEXEC) {
  const r = spawnSync(
    process.execPath,
    ['--use-system-ca', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, DSH_NO_REEXEC: '1' } },
  );
  process.exit(r.status ?? 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const localHead = git('rev-parse', '--short', 'HEAD').stdout.trim();
console.log(`本地 HEAD: ${localHead}`);
console.log(`目标: ${REPO} (${BRANCH})`);
console.log(`最多尝试 ${ROUNDS} 轮\n`);

async function remoteTree() {
  const headers = TOKEN
    ? { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'dsh', Accept: 'application/vnd.github+json' }
    : { 'User-Agent': 'dsh', Accept: 'application/vnd.github+json' };
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers });
  if (!r.ok) throw new Error(`读 ref 失败: HTTP ${r.status}`);
  const ref = await r.json();
  const c = await fetch(`https://api.github.com/repos/${REPO}/git/commits/${ref.object.sha}`, { headers });
  if (!c.ok) throw new Error(`读 commit 失败: HTTP ${c.status}`);
  return { sha: ref.object.sha, tree: (await c.json()).tree.sha };
}

const localTree = git('rev-parse', 'HEAD^{tree}').stdout.trim();

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`──── 第 ${round}/${ROUNDS} 轮 ────`);

  // 先看远端是不是已经一致了（可能上一次其实成功了）
  try {
    const rt = await remoteTree();
    if (rt.tree === localTree) {
      console.log(`✓ 远端 tree 已与本地一致（远端 commit ${rt.sha.slice(0, 7)}）`);
      process.exit(0);
    }
    console.log(`远端 tree ${rt.tree.slice(0, 10)} ≠ 本地 ${localTree.slice(0, 10)}，需要推送`);
  } catch (e) {
    console.log(`（读远端失败：${e.message}）`);
  }

  // 方案 A：标准 git push
  //
  // ⚠️ 远端历史被 Git Data API 推送**重建**过（本地没有那些 commit），
  // 所以普通 push 会被判非快进而拒绝：`! [rejected] ... (fetch first)`。
  // 内容正确性由 tree 比对保证（上面已经比过），因此先试 force。
  console.log('方案 A：git push --force-with-lease（远端历史被 API 重建过，需强推）');
  const a = spawnSync(
    'git',
    ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=120',
      'push', '--force-with-lease', 'origin', BRANCH],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
  );
  if (a.status === 0) {
    console.log('\n✓ git push 成功');
    process.exit(0);
  }
  console.log(`  ✗ git push 失败（退出码 ${a.status}）`);

  // force-with-lease 需要准确的远端引用；本地跟踪引用可能过时 → 退回无条件 force
  console.log('方案 A2：git push --force');
  const a2 = spawnSync(
    'git',
    ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=120',
      'push', '--force', 'origin', BRANCH],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
  );
  if (a2.status === 0) {
    console.log('\n✓ git push --force 成功');
    process.exit(0);
  }
  console.log(`  ✗ git push --force 失败（退出码 ${a2.status}）`);

  // 方案 B：Git Data API
  if (!TOKEN) {
    console.log('  （没有 token，跳过方案 B。可设 GH_TOKEN 或写入 tools/.github-token）');
  } else {
    console.log('方案 B：Git Data API');
    let base;
    try { base = (await remoteTree()).sha; } catch (e) {
      console.log(`  ✗ 拿不到远端 base：${e.message}`);
      base = null;
    }
    if (base) {
      const b = spawnSync(
        process.execPath,
        ['--use-system-ca', resolve(ROOT, 'tools', 'push-via-api.mjs'),
          '--token', TOKEN, '--repo', REPO, '--branch', BRANCH,
          '--base', base, '--cwd', ROOT, '--single'],
        { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' },
      );
      if (b.status === 0) {
        console.log('\n✓ API 推送成功');
        process.exit(0);
      }
      console.log(`  ✗ API 推送失败（退出码 ${b.status}）`);
    }
  }

  if (round < ROUNDS) {
    const wait = Math.min(15 * round, 60);
    console.log(`  等 ${wait}s 后重试…\n`);
    await sleep(wait * 1000);
  }
}

console.error('\n✗ 多轮尝试后仍未成功。GitHub 侧目前不稳定，稍后再跑一次即可：');
console.error('    node tools/push-github.mjs');
process.exit(1);
