import { pathToFileURL } from 'node:url';
const s = await import(pathToFileURL('E:/code/小魔怪/shared/dist/index.js').href);

const show = (name) => {
  const v = s[name];
  const kind = Array.isArray(v) ? `Array(${v.length})` : typeof v;
  let sample = '';
  try {
    if (Array.isArray(v)) sample = JSON.stringify(v[0])?.slice(0, 120);
    else if (v && typeof v === 'object') sample = JSON.stringify(Object.values(v)[0])?.slice(0, 160);
  } catch { /* ignore */ }
  console.log(`${name.padEnd(22)} ${kind.padEnd(16)} ${sample}`);
};

console.log('=== shared 顶层导出（关键名） ===');
for (const n of ['BOARD_MAPS', 'NORMAL_MAP', 'BOARD', 'CARD_BY_ID', 'CARDS', 'ACTION_CARDS',
  'CHARACTERS', 'CHARACTER_BY_ID', 'MISFORTUNES', 'JAIL_CARDS', 'CELL_TYPES', 'BOARD_VIEW']) {
  try { show(n); } catch (e) { console.log(`${n.padEnd(22)} <err> ${e.message}`); }
}

console.log('\n=== 直接看 gamedata 子模块 ===');
const gd = await import(pathToFileURL('E:/code/小魔怪/shared/dist/gamedata/index.js').href);
console.log('gamedata.BOARD_MAPS     ', Array.isArray(gd.BOARD_MAPS) ? `Array(${gd.BOARD_MAPS.length})` : typeof gd.BOARD_MAPS);
console.log('gamedata.CARD_BY_ID keys', Object.keys(gd.CARD_BY_ID).length);
const a001 = gd.CARD_BY_NAME.a001;
console.log('gamedata a001.move      ', a001?.move);

console.log('\n=== 顶层 CARD_BY_ID 里的 a001 ===');
const topCard = s.CARD_BY_ID?.[Object.keys(s.CARD_BY_ID ?? {})[0]];
console.log('顶层 CARD_BY_ID 首项 keys:', topCard ? Object.keys(topCard).slice(0, 12).join(',') : '(空)');
console.log('顶层 CARD_BY_ID 有 move?  ', topCard && 'move' in topCard);

console.log('\n=== board-view 内部用的是哪个 ===');
const bv = await import(pathToFileURL('E:/code/小魔怪/shared/dist/board-view.js').href);
console.log('board-view 导出:', Object.keys(bv).slice(0, 12).join(', '));
