// =============================================================
// 经 GitHub Git Data API 推送本地提交（github.com:443 不通时的备用通道）
//
// `git push` 走 github.com:443；当它超时但 api.github.com 可用时，
// 用 Git Data API 把本地提交的对象上传并更新远端 ref。
//
// 用法：
//   node --use-system-ca tools/push-via-api.mjs \
//     --token <PAT> --repo owner/name --branch master \
//     --base <远端当前 sha> [--head <本地 sha，默认 HEAD>] --cwd <仓库目录>
//
// 注意：
//  - Node 的 fetch 不读系统证书库，必须加 `--use-system-ca`
//  - 细粒度 PAT 需要把 Contents 设为 Read and write
//  - 会逐层上传 base..head 之间的每个提交（保持历史，不压平）
// =============================================================
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const TOKEN = arg('token', process.env.GH_TOKEN ?? '');
const REPO = arg('repo');
const BRANCH = arg('branch', 'master');
const BASE = arg('base');
const CWD = arg('cwd', process.cwd());

if (!TOKEN || !REPO || !BASE) {
  console.error('缺少参数：需要 --token --repo --base');
  process.exit(1);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-push',
  'Content-Type': 'application/json',
};

const git = (...args) => execFileSync('git', args, { cwd: CWD, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403 && /Resource not accessible/i.test(text)) {
      throw new Error(
        `${method} ${path} → 403：细粒度 PAT 缺少写权限。`
        + '请在 token 设置里把「Contents」改为 Read and write。',
      );
    }
    throw new Error(`${method} ${path} → HTTP ${res.status}\n${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
};

const HEAD = arg('head', git('rev-parse', 'HEAD'));

// --single：不管本地与 base 有无共同祖先，直接把 HEAD 的**完整 tree**
// 作为一个新提交挂到 base 下。
//
// 这是必要的，因为 Git Data API 推送会**重建对象** → 远端会得到一个本地
// 不存在的 commit sha。而 github.com 不通时又无法 fetch 回来，
// 于是"本地 ancestry"与"远端 ancestry"会永久错位。
// `--single` 绕开祖先关系，只看内容（内容正确性靠 tree 比对保证）。
const SINGLE = argv.includes('--single');

if (!SINGLE) {
  // 待推送的提交（旧的在前），保证 parent 顺序正确
  const commits = git('rev-list', '--reverse', `${BASE}..${HEAD}`).split('\n').filter(Boolean);
  if (!commits.length) {
    console.log('没有待推送的提交');
    process.exit(0);
  }
  console.log(`基准 ${BASE.slice(0, 7)} → 待推送 ${commits.length} 个提交`);
}

/** 上传一个 tree（递归），返回新 tree sha */
const uploadTree = async (treeSha) => {
  // `git cat-file -p <tree>` 输出的是 ls-tree 文本：
  //   <mode> <type> <sha>\t<path>
  // 注意 path 里可能有空格，所以只按**第一个制表符**切分。
  const text = execFileSync('git', ['cat-file', '-p', treeSha], { cwd: CWD, encoding: 'utf8', maxBuffer: 1 << 28 });
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const path = line.slice(tab + 1);
    entries.push({ mode: meta[0], type: meta[1], sha: meta[2], path });
  }

  const out = [];
  for (const e of entries) {
    if (e.type === 'commit') {
      // submodule：直接沿用原 sha
      out.push({ path: e.path, mode: e.mode, type: 'commit', sha: e.sha });
      continue;
    }
    if (e.type === 'tree') {
      out.push({ path: e.path, mode: e.mode, type: 'tree', sha: await uploadTree(e.sha) });
      continue;
    }
    const buf = execFileSync('git', ['cat-file', 'blob', e.sha], { cwd: CWD, maxBuffer: 1 << 28 });
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    out.push({ path: e.path, mode: e.mode, type: 'blob', sha: blob.sha });
  }
  const created = await api('POST', `/repos/${REPO}/git/trees`, { tree: out });
  return created.sha;
};

// --single 模式：把 HEAD 的完整 tree 作为**一个**新提交挂到 BASE 下
if (SINGLE) {
  console.log(`单提交模式：把 HEAD(${HEAD.slice(0, 7)}) 的 tree 挂到 ${BASE.slice(0, 7)} 下`);
  const msg = git('log', '-1', '--pretty=%B', HEAD);
  const newTree = await uploadTree(git('rev-parse', `${HEAD}^{tree}`));
  const c = await api('POST', `/repos/${REPO}/git/commits`, {
    message: msg, tree: newTree, parents: [BASE],
  });
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: c.sha, force: false });
  console.log(`✓ 已更新 ${BRANCH} → ${c.sha}`);
  process.exit(0);
}

let parent = BASE;
for (const sha of commits) {
  const msg = git('log', '-1', '--pretty=%B', sha);
  const treeSha = git('rev-parse', `${sha}^{tree}`);
  process.stdout.write(`  上传 ${sha.slice(0, 7)} tree…`);
  const newTree = await uploadTree(treeSha);
  const c = await api('POST', `/repos/${REPO}/git/commits`, {
    message: msg, tree: newTree, parents: [parent],
  });
  parent = c.sha;
  console.log(` → ${c.sha.slice(0, 7)}`);
}

await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: parent, force: false });
console.log(`✓ 已更新 ${BRANCH} → ${parent}`);
