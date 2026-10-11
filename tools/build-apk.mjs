// 一键构建 Android APK
//
// 用法:  node tools/build-apk.mjs [debug|release]
//
// 为什么用 Node 而不是 npm script / PowerShell：
//  1. 本机 `npx.ps1` / `.ps1` 被执行策略拦住，直接调 CLI 的 bin 更稳；
//  2. 环境变量（JAVA_HOME / ANDROID_HOME）需要在本进程内设好再调 gradlew；
//  3. 路径含中文（"小魔怪-push"），必须显式指定编码，否则子进程输出乱码。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const clientDir = resolve(root, 'client');
const androidDir = resolve(clientDir, 'android');

const JDK = process.env.JDK_HOME || 'D:\\devtools\\jdk-17.0.20.1+1';
const SDK = process.env.ANDROID_HOME || 'D:\\devtools\\android-sdk';
const GRADLE_HOME = process.env.GRADLE_USER_HOME || 'D:\\devtools\\gradle-home';

const variant = (process.argv[2] || 'debug').toLowerCase();
if (!['debug', 'release'].includes(variant)) {
  console.error(`未知的构建类型: ${variant}（只支持 debug / release）`);
  process.exit(1);
}

for (const [label, p] of [['JDK', JDK], ['Android SDK', SDK]]) {
  if (!existsSync(p)) {
    console.error(`✗ ${label} 不存在: ${p}`);
    console.error('  （可用 JDK_HOME / ANDROID_HOME 环境变量覆盖）');
    process.exit(1);
  }
}

const env = {
  ...process.env,
  JAVA_HOME: JDK,
  ANDROID_HOME: SDK,
  ANDROID_SDK_ROOT: SDK,
  GRADLE_USER_HOME: GRADLE_HOME,
  PATH: `${JDK}\\bin;${SDK}\\platform-tools;${process.env.PATH}`,
};

const run = (title, cmd, args, cwd) => {
  console.log(`\n=== ${title} ===`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: false });
  if (r.error) {
    console.error(`\n✗ ${title} 无法启动: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n✗ ${title} 失败（退出码 ${r.status}）`);
    process.exit(r.status ?? 1);
  }
};

// 1) 构建 web 产物
//
// 直接用 tsc / vite 的 JS 入口，而不是 `npm run build`：
// 本机 npm 只有 .cmd/.ps1（执行策略还会拦 .ps1），绕过去最省事。
const tscBin = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = resolve(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
const viteBinHoisted = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = existsSync(viteBin) ? viteBin : viteBinHoisted;
if (!existsSync(vite)) {
  console.error(`✗ 找不到 vite: ${viteBin} / ${viteBinHoisted}`);
  process.exit(1);
}
run('1/3 类型检查 (tsc -b)', process.execPath, [tscBin, '-b'], clientDir);
run('1/3 打包 (vite build)', process.execPath, [vite, 'build'], clientDir);

// 2) cap sync（把 web 产物拷进 android 工程）
const capBin = resolve(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
run('2/3 cap sync android', process.execPath, [capBin, 'sync', 'android'], clientDir);

// 3) gradle 打包
//
// 直接调 Gradle 的 launcher jar（= gradlew.bat 内部做的事），
// 而不是走 gradlew.bat：后者在 Windows 上必须 `shell: true`，
// 而带 shell 的子进程在参数含中文路径时容易被再解释一遍。
const launcherJar = resolve(GRADLE_HOME, 'wrapper', 'dists');
if (!existsSync(launcherJar)) {
  console.error(`✗ 找不到 Gradle wrapper 缓存: ${launcherJar}`);
  console.error('  （先跑一次 client/android/gradlew.bat 让它自己下载）');
  process.exit(1);
}
// 在 dists 下递归找解压好的 gradle-*/lib/gradle-launcher-*.jar
// （目录结构是 dists/<发行包名>/<随机哈希>/gradle-<版本>/lib/，哈希那层名字不固定）
const { readdirSync: rd } = await import('node:fs');
const findLauncher = (dir, depth = 0) => {
  if (depth > 6) return null;
  let entries;
  try { entries = rd(dir, { withFileTypes: true }); } catch { return null; }
  // 先看本层有没有 lib/gradle-launcher-*.jar
  if (entries.some((e) => e.isDirectory() && e.name === 'lib')) {
    const libDir = resolve(dir, 'lib');
    const jar = rd(libDir).find((f) => /^gradle-launcher-.*\.jar$/.test(f));
    if (jar) return resolve(libDir, jar);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findLauncher(resolve(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
};
const launcher = findLauncher(launcherJar);
if (!launcher) {
  console.error('✗ 在 Gradle 缓存里找不到 gradle-launcher jar');
  console.error(`  已搜索: ${launcherJar}`);
  process.exit(1);
}

const task = `assemble${variant[0].toUpperCase()}${variant.slice(1)}`;
run(`3/3 gradle ${task}`, `${JDK}\\bin\\java.exe`, [
  '-Xmx1536m',
  '-classpath', launcher,
  'org.gradle.launcher.GradleMain',
  task, '--no-daemon', '--console=plain',
], androidDir);

// 汇报产物
const outDir = resolve(androidDir, 'app', 'build', 'outputs', 'apk', variant);
console.log('\n=== 产物 ===');
if (!existsSync(outDir)) {
  console.error(`  ✗ 目录不存在: ${outDir}`);
  process.exit(1);
}
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(outDir)) {
  if (!f.endsWith('.apk')) continue;
  const full = resolve(outDir, f);
  const mb = (statSync(full).size / 1024 / 1024).toFixed(2);
  console.log(`  ✓ ${full}`);
  console.log(`    ${f}  ${mb} MB`);
}
console.log(`\n安装到手机： adb install -r <上面的 apk 路径>`);
