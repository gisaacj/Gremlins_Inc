import { useGameStore } from '../store/game.js';
import '../styles/gameover.css';

export function GameOver() {
  const game = useGameStore((s) => s.game);
  const winnerId = useGameStore((s) => s.winnerId);
  const leaveRoom = useGameStore((s) => s.leaveRoom);

  const winner = game?.players.find((p) => p.id === winnerId);

  return (
    <div className="gameover">
      <div className="gameover-title">游戏结束</div>
      {winner && (
        <div className="gameover-winner">
          {winner.name}（{winner.characterId}）获胜！
          <br />
          <span style={{ color: 'var(--color-gold)' }}>
            {winner.resources.cogs} 齿轮 / {game?.targetCogs}
          </span>
        </div>
      )}
      <div className="gameover-actions">
        <button className="primary" onClick={leaveRoom}>返回主菜单</button>
      </div>
    </div>
  );
}
