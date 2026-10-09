import { useGameStore } from '../store/game.js';
import { CHARACTERS } from '@gremlins/shared';
import '../styles/lobby.css';

export function Lobby() {
  const lobby = useGameStore((s) => s.lobby);
  const mySocketId = useGameStore((s) => s.mySocketId);
  const setReady = useGameStore((s) => s.setReady);
  const addAI = useGameStore((s) => s.addAI);
  const updateConfig = useGameStore((s) => s.updateConfig);
  const startGame = useGameStore((s) => s.startGame);
  const leaveRoom = useGameStore((s) => s.leaveRoom);

  if (!lobby) return null;

  const isHost = lobby.hostId === mySocketId;
  const me = lobby.players.find((p) => p.id === mySocketId);
  // 房主点开始游戏即视为准备好；其他真人玩家需先点"准备"
  const othersReady = lobby.players.every(
    (p) => p.id === mySocketId || p.isAI || p.ready,
  );

  return (
    <div className="lobby">
      <div className="lobby-header">
        <div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>房间号（分享给好友）</div>
          <div className="lobby-roomid">{lobby.roomId}</div>
        </div>
        <button onClick={leaveRoom}>离开</button>
      </div>

      <div className="lobby-body">
        <div className="lobby-section">
          <h3>玩家 ({lobby.players.length}/{lobby.config.maxPlayers})</h3>
          <div className="player-list">
            {lobby.players.map((p) => (
              <div
                key={p.id}
                className={`player-row ${p.id === lobby.hostId ? 'is-host' : ''} ${p.id === mySocketId ? 'is-me' : ''} ${p.isAI ? 'is-ai' : ''}`}
              >
                <div>
                  <span className="player-name">{p.name}</span>
                  {p.id === lobby.hostId && <span className="player-tag host" style={{ marginLeft: 8 }}>房主</span>}
                  {p.isAI && <span className="player-tag ai" style={{ marginLeft: 8 }}>AI</span>}
                  {!p.isAI && p.ready && <span className="player-tag ready" style={{ marginLeft: 8 }}>已准备</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lobby-section">
          <h3>游戏设置</h3>
          <div className="config-row">
            <span>目标齿轮数</span>
            <select
              value={lobby.config.targetCogs}
              disabled={!isHost}
              onChange={(e) => updateConfig({ targetCogs: Number(e.target.value) })}
            >
              <option value={15}>15（快）</option>
              <option value={30}>30（标准）</option>
              <option value={45}>45（持久）</option>
              <option value={60}>60（马拉松）</option>
            </select>
          </div>
          <div className="config-row">
            <span>最大玩家数</span>
            <select
              value={lobby.config.maxPlayers}
              disabled={!isHost}
              onChange={(e) => updateConfig({ maxPlayers: Number(e.target.value) })}
            >
              {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div className="config-row">
            <span>暴乱卡牌</span>
            <select
              value={lobby.config.enableRiotCards ? 1 : 0}
              disabled={!isHost}
              onChange={(e) => updateConfig({ enableRiotCards: e.target.value === '1' })}
            >
              <option value={1}>启用</option>
              <option value={0}>禁用</option>
            </select>
          </div>
          <div className="config-row" style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>
            <span>共 {CHARACTERS.length} 个角色可选</span>
          </div>
        </div>
      </div>

      <div className="lobby-actions">
        {isHost && (
          <>
            <button onClick={addAI} disabled={lobby.players.length >= lobby.config.maxPlayers}>
              + 添加 AI
            </button>
            <button
              className="primary"
              onClick={startGame}
              disabled={!othersReady || lobby.players.length < 2}
            >
              开始游戏（进入角色选择）
            </button>
          </>
        )}
        {!isHost && (
          <button
            className="primary"
            onClick={() => setReady(!me?.ready)}
          >
            {me?.ready ? '取消准备' : '我准备好了'}
          </button>
        )}
      </div>
    </div>
  );
}
