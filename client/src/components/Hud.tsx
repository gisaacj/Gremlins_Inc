import { useEffect, useRef } from 'react';
import type { SerializedGameState, SerializedPlayer } from '@gremlins/shared';
import { CHARACTER_BY_ID, CARD_BY_ID } from '@gremlins/shared';
import { PLAYER_COLORS } from '@gremlins/shared';
import { useState } from 'react';
import { CardDetail } from './Card.js';
import '../styles/hud.css';

interface Props {
  game: SerializedGameState;
  myPlayer?: SerializedPlayer;
}

export function ResourcePanel({ game, myPlayer }: Props) {
  if (!myPlayer) return null;
  const target = game.targetCogs;
  const pct = Math.min(100, (myPlayer.resources.cogs / target) * 100);
  const char = myPlayer.characterId ? CHARACTER_BY_ID[myPlayer.characterId] : undefined;

  return (
    <div className="hud">
      <div className="hud-row">
        <span style={{ color: 'var(--color-text-muted)' }}>
          {char?.text.name ?? '???'} · {char?.name}
        </span>
        <span style={{ fontSize: 11 }}>
          {myPlayer.isCurrentTurn ? '【你的回合】' : `等待 ${game.players.find((p) => p.isCurrentTurn)?.name ?? ''}`}
        </span>
      </div>

      <div className="hud-row">
        <div className="hud-resource">
          <span className="icon gold">$</span>
          <div>
            <div className="label">金币</div>
            <div className="value gold">{myPlayer.resources.gold}</div>
          </div>
        </div>
        <div className="hud-resource">
          <span className="icon">⊖</span>
          <div>
            <div className="label">贿赂</div>
            <div className="value">{myPlayer.resources.bribe ?? 0}</div>
          </div>
        </div>
        <div className="hud-resource">
          <span className="icon votes">☑</span>
          <div>
            <div className="label">选票</div>
            <div className="value votes">{myPlayer.resources.votes}</div>
          </div>
        </div>
        <div className="hud-resource">
          <span className="icon malice">☠</span>
          <div>
            <div className="label">罪恶</div>
            <div className="value malice">{myPlayer.resources.malice}</div>
          </div>
        </div>
      </div>

      <div className="hud-row">
        <div className="hud-resource">
          <span className="icon cogs">⚙</span>
          <div>
            <div className="label">齿轮 {myPlayer.resources.cogs}/{target}</div>
            <div className="value cogs">{myPlayer.resources.cogs}</div>
          </div>
        </div>
        <div className="hud-resource">
          <span className="icon">⊕</span>
          <div>
            <div className="label">收入</div>
            <div className="value">{myPlayer.resources.income}</div>
          </div>
        </div>
        <div className="hud-resource">
          <span className="icon">#</span>
          <div>
            <div className="label">刑期</div>
            <div className="value">{myPlayer.jailExperience}</div>
          </div>
        </div>
      </div>

      <div className="cog-bar">
        <div className="cog-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function PlayerList({ game, mySocketId }: { game: SerializedGameState; mySocketId: string }) {
  return (
    <div className="player-status-list">
      {game.players.map((p) => {
        const colors = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
        const char = p.characterId ? CHARACTER_BY_ID[p.characterId] : undefined;
        return (
          <div
            key={p.id}
            className={`player-status-row ${p.id === mySocketId ? 'me' : ''} ${p.isCurrentTurn ? 'turn' : ''} ${game.mayorId === p.id ? 'mayor' : ''} ${!p.connected ? 'disconnected' : ''}`}
          >
            <div className="player-avatar" style={{ background: colors.primary }}>
              {(p.name[0] || '?').toUpperCase()}
            </div>
            <div className="player-name">
              {p.name}
              {char && <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal', marginLeft: 4 }}>{char.text.name}</span>}
            </div>
            <div className="player-res">
              <span title="齿轮">⚙{p.resources.cogs}</span>
              <span title="金币">${p.resources.gold}</span>
              <span title="手牌">🂠{p.handCount}</span>
            </div>
            <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {game.mayorId === p.id && <span className="tag-mayor">镇长</span>}
              {p.inJail && <span className="tag-jail">狱</span>}
              {p.skipNextTurn && <span className="tag-skip">跳</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LogBox({ game, mySocketId }: { game: SerializedGameState; mySocketId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const logLen = game.log.length;
  const lastTurn = game.log[logLen - 1]?.turn ?? 0;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLen, lastTurn]);

  // 构建卡牌名→ID映射
  const cardNameMap: Record<string, string> = {};
  for (const [id, card] of Object.entries(CARD_BY_ID)) {
    cardNameMap[card.name] = id;
  }

  // 把日志文本中的卡牌名渲染为可点击span
  function renderText(text: string) {
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;
    while (remaining.length > 0) {
      let found = false;
      for (const name of Object.keys(cardNameMap)) {
        const idx = remaining.indexOf(name);
        if (idx >= 0) {
          if (idx > 0) parts.push(remaining.slice(0, idx));
          parts.push(
            <span
              key={key++}
              className="log-card-link"
              onClick={() => setDetailCardId(cardNameMap[name])}
            >
              {name}
            </span>
          );
          remaining = remaining.slice(idx + name.length);
          found = true;
          break;
        }
      }
      if (!found) {
        parts.push(remaining);
        break;
      }
    }
    return parts;
  }

  return (
    <>
      <div className="log-box" ref={ref}>
        {game.log.slice(-100).map((entry, i) => {
          const player = game.players.find((p) => p.id === entry.playerId);
          const isSystem = !entry.playerId || entry.playerId === '_system';
          const colors = player ? PLAYER_COLORS[player.colorIndex % PLAYER_COLORS.length] : null;
          const isMe = player && entry.playerId === mySocketId;
          return (
            <div key={i} className={`log-entry ${isSystem ? 'system' : ''} ${isMe ? 'me' : ''}`}>
              <span style={{ color: 'var(--color-text-muted)' }}>[T{entry.turn}]</span>{' '}
              {!isSystem && player && (
                <span style={{ color: colors?.primary ?? undefined, fontWeight: 600 }}>
                  {player.name}：
                </span>
              )}
              {renderText(entry.text)}
            </div>
          );
        })}
      </div>
      {detailCardId && (
        <CardDetail cardId={detailCardId} onClose={() => setDetailCardId(null)} canPlay={false} />
      )}
    </>
  );
}
