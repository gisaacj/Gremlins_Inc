// 解析 Gremlins, Inc. 语言包 (TextAsset "Loc/<Language>")
// 与游戏内 GBufferReader 一致:
//   int32 count, 然后 count * (8 字节 UIN, int32 byteLen, byteLen 字节 UTF-16LE 文本)
//   ReadString 取的是字节长度, 文本用 Encoding.Unicode 解码
const fs = require('fs');
const path = require('path');

function parseLocPack(buf) {
  const count = buf.readInt32LE(0);
  let p = 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 12 > buf.length) break;
    const uinBytes = buf.subarray(p, p + 8); p += 8;
    const len = buf.readInt32LE(p); p += 4;
    if (len < 0 || p + len > buf.length) break;
    const text = buf.toString('utf16le', p, p + len); p += len;
    entries.push({ uin: uinBytes, uinHex: '0x' + uinBytes.toString('hex').toUpperCase(), text });
  }
  return { count, entries, consumed: p, total: buf.length };
}

if (require.main === module) {
  const file = process.argv[2];
  const buf = fs.readFileSync(file);
  const { count, entries, consumed, total } = parseLocPack(buf);
  console.log(`文件: ${file}`);
  console.log(`声明: ${count}  解析: ${entries.length}  消耗: ${consumed}/${total}  完整: ${consumed === total}`);
  console.log('--- 前 5 条 ---');
  for (const e of entries.slice(0, 5)) console.log(`  ${e.uinHex}  ${JSON.stringify(e.text)}`);

  const labelsPath = path.join(__dirname, '..', 'data', 'misc_Labels.json');
  if (fs.existsSync(labelsPath)) {
    const gl = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
    const list = gl.LabelList || {};
    const map = new Map(entries.map((e) => [e.uinHex, e.text]));
    let hit = 0; const samples = [];
    for (const k of Object.keys(list)) {
      const key = '0x' + k.toUpperCase();
      if (map.has(key)) { hit++; if (samples.length < 8) samples.push(`${list[k]} => ${JSON.stringify(map.get(key))}`); }
    }
    console.log(`\nGLabels 交叉验证: ${hit}/${Object.keys(list).length} 命中`);
    samples.forEach((s) => console.log('  ' + s));
  }
}

module.exports = { parseLocPack };
