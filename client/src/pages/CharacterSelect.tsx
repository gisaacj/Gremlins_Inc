import { useGameStore } from '../store/game.js';
import {
  CHARACTERS, CHARACTER_BY_ID,
  characterAbilities, tileLabel, getBoardView, NORMAL_MAP,
} from '@gremlins/shared';
import type { GameCharacter } from '@gremlins/shared';
import '../styles/charselect.css';

/** 角色起始格的中文地点名（从真实棋盘 + 格子类型推导） */
function startPlaceLabel(char: GameCharacter): string {
  const board = getBoardView(NORMAL_MAP.id);
  const tile = board.byId.get(char.normalStartCellId);
  if (!tile) return '';
  return tileLabel(board, tile.id);
}

export function CharacterSelect() {
  const lobby = useGameStore((s) => s.lobby);
  const mySocketId = useGameStore((s) => s.mySocketId);
  const selectCharacter = useGameStore((s) => s.selectCharacter);
  const startGame = useGameStore((s) => s.startGame);

  if (!lobby) return null;

  const isHost = lobby.hostId === mySocketId;
  const me = lobby.players.find((p) => p.id === mySocketId);
  const takenBy = (charId: string) => lobby.players.find((p) => p.characterId === charId);

  return (
    <div className="char-select">
      <div className="char-select-header">
        <h2>选择角色</h2>
        <p>行动顺序来自原版 <code>StepOrderNum</code>，技能文案解析自原作数据</p>
      </div>

      <div className="char-grid">
        {CHARACTERS.map((c) => {
          const taker = takenBy(c.id);
          const isSelectedByMe = me?.characterId === c.id;
          const disabled = !!taker && !isSelectedByMe;
          const abilities = characterAbilities(c);
          const startPlace = startPlaceLabel(c);
          return (
            <div
              key={c.id}
              className={`char-card ${isSelectedByMe ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
              onClick={() => !disabled && selectCharacter(c.id)}
            >
              <div className="char-order">#{String(c.order).padStart(2, '0')}</div>
              <div className="char-name">{c.text.name}</div>
              <div className="char-cn">{c.name}</div>
              {startPlace && <div className="char-building">起始：{startPlace}</div>}
              <div className="char-abilities">
                {abilities.map((a, i) => (
                  <div key={i} className="char-ability-item">
                    <span className="char-ability-name">{a.name}</span>
                    <span className="char-ability-desc">{a.description}</span>
                  </div>
                ))}
                {!abilities.length && (
                  <div className="char-ability-item">
                    <span className="char-ability-desc">（原版未提供说明）</span>
                  </div>
                )}
              </div>
              {taker && (
                <div className="char-owner">
                  {taker.id === mySocketId ? '你已选' : `${taker.name} 已选`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="char-select-footer">
        {isHost ? (
          <button className="primary" onClick={startGame} disabled={!me?.characterId}>
            开始游戏
          </button>
        ) : (
          <div style={{ flex: 1, textAlign: 'center', color: 'var(--color-text-muted)', padding: 8 }}>
            {me?.characterId
              ? `已选 ${CHARACTER_BY_ID[me.characterId]?.text.name}，等待房主开始`
              : '请选择角色'}
          </div>
        )}
      </div>
    </div>
  );
}
