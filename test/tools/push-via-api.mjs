/**
 * 通过 GitHub Git Data API 推送本地改动。
 *
 * 用途：网络只能到达 api.github.com、git push（443 到 github.com）超时时，
 * 用 REST API 直接写对象。GitHub 的 blob SHA 与 `git hash-object -w`
 * 完全一致，所以可以先用 git 本地算出 SHA，只把缺失的对象传上去。
 *
 * 用法: node tools/push-via-api.mjs --token <token> --repo <owner/name> --branch master \
 *          --base <本地 base commit 的树对应提交> --message-file <文件>
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const TOKEN = arg('token');
const REPO = arg('repo', 'gisaacj/Gremlins_Inc');
const BRANCH = arg('branch', 'master');
const BASE_SHA = arg('base');
const MSG_FILE = arg('message-file');
const CWD = arg('cwd', process.cwd());
if (!TOKEN) throw new Error('缺少 --token');

const API = 'https://api.github.com';
const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-push',
  'Content-Type': 'application/json',
};

const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}\n${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
};

const git = (...a) => execFileSync('git', a, { cwd: CWD, encoding: 'utf8' }).trim();

/** 列出本地相对 base 改动过的文件（含新增/删除） */
const changed = git('diff', '--name-status', BASE_SHA, 'HEAD')
  .split('\n').filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status[0], path: rest[rest.length - 1] };
  });

console.log(`基准提交 ${BASE_SHA.slice(0, 7)} → 待推送 ${changed.length} 个文件`);

// 1) 找到远端 base 提交的 tree
const baseCommit = await api('GET', `/repos/${REPO}/git/commits/${BASE_SHA}`);
const baseTree = baseCommit.tree.sha;
console.log(`远端 base tree ${baseTree.slice(0, 7)}`);

// 2) 逐个文件：本地算 SHA → 缺失就上传
const entries = [];
for (const f of changed) {
  if (f.status === 'D') {
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); // null = 删除
    console.log(`  删除 ${f.path}`);
    continue;
  }
  const sha = git('hash-object', '-w', '--', f.path);
  const mode = (() => {
    const m = git('ls-files', '-s', '--', f.path).split(' ')[0];
    return m || '100644';
  })();
  entries.push({ path: f.path, mode, type: 'blob', sha });

  // 远端已有该对象就跳过上传
  let exists = true;
  try { await api('GET', `/repos/${REPO}/git/blobs/${sha}`); }
  catch { exists = false; }

  if (!exists) {
    const content = readFileSync(`${CWD}/${f.path}`).toString('base64');
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
    if (blob.sha !== sha) {
      throw new Error(`SHA 不一致 ${f.path}: 本地 ${sha.slice(0, 7)} vs 远端 ${blob.sha.slice(0, 7)}`);
    }
    console.log(`  上传 ${f.path}  (${sha.slice(0, 7)})`);
  } else {
    console.log(`  已存在 ${f.path}  (${sha.slice(0, 7)})`);
  }
}

// 3) 建树（基于远端 base tree，只替换改动项）
const tree = await api('POST', `/repos/${REPO}/git/trees`, {
  base_tree: baseTree,
  tree: entries,
});
console.log(`新 tree ${tree.sha.slice(0, 7)}`);

// 4) 建提交（父提交用远端当前 HEAD，保证快进）
const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
const parentSha = ref.object.sha;
const message = MSG_FILE
  ? readFileSync(MSG_FILE, 'utf8')
  : git('log', '-1', '--pretty=%B');
const commit = await api('POST', `/repos/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [parentSha],
});
console.log(`新提交 ${commit.sha.slice(0, 7)}（父 ${parentSha.slice(0, 7)}）`);

// 5) 更新分支
await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`\n✅ 已推送到 ${REPO} 的 ${BRANCH}`);
