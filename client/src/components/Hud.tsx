import { useEffect, useRef, useMemo } from 'react';
import type { SerializedGameState, SerializedPlayer } from '@gremlins/shared';
import {
  CHARACTER_BY_ID, CARD_BY_ID, MISFORTUNE_CARDS, JAIL_CARDS, CHAOS_CARDS,
  characterAbilities,
} from '@gremlins/shared';
import { PLAYER_COLORS, BOARD_VIEW, getBoardView } from '@gremlins/shared';
import { useState } from 'react';
import { CardDetail } from './Card.js';
import '../styles/hud.css';

/**
 * 把棋盘格 id 转成可读的站点名。
 *
 * 用于玩家面板显示"他在哪个站点" —— 用户反馈面板状态不够全（bug #7）。
 * 棋盘格 id 是原版 UIN 字符串，界面不能直接显示。
 */
function positionLabel(position: string | undefined): string {
  if (!position) return '—';
  const view = getBoardView() ?? BOARD_VIEW;
  const tile = view?.byId?.get(position);
  if (!tile) return '未知';
  return tile.label || tile.cellType || '未知';
}

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

/** 永久卡牌（装备）面板 */
export function PermanentPanel({ permanents }: { permanents: string[] }) {
  const [detailCardId, setDetailCardId] = useState<string | null>(null);

  if (!permanents?.length) {
    return (
      <div className="perm-panel">
        <span className="perm-empty">无激活的永久卡牌</span>
      </div>
    );
  }

  return (
    <>
      <div className="perm-panel">
        {permanents.map((id, i) => {
          const card = CARD_BY_ID[id];
          if (!card) return null;
          return (
            <div
              key={i}
              className="perm-item"
              onClick={() => setDetailCardId(id)}
              title={card.text?.name}
            >
              <span className="perm-name">{card.text?.name ?? card.name}</span>
              {card.text?.description && (
                <span className="perm-desc">{card.text.description.slice(0, 50)}</span>
              )}
            </div>
          );
        })}
      </div>
      {detailCardId && CARD_BY_ID[detailCardId] && (
        <CardDetail cardId={detailCardId} onClose={() => setDetailCardId(null)} canPlay={false} />
      )}
    </>
  );
}

export function PlayerList({ game, mySocketId }: { game: SerializedGameState; mySocketId: string }) {
  const [detailCharId, setDetailCharId] = useState<string | null>(null);

  return (
    <>
      <div className="player-status-list">
        {game.players.map((p) => {
          const colors = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
          const char = p.characterId ? CHARACTER_BY_ID[p.characterId] : undefined;
          return (
            <div
              key={p.id}
              className={`player-status-row ${p.id === mySocketId ? 'me' : ''} ${p.isCurrentTurn ? 'turn' : ''} ${game.mayorId === p.id ? 'mayor' : ''} ${!p.connected ? 'disconnected' : ''}`}
              onClick={() => char && setDetailCharId(char.id)}
              style={{ cursor: char ? 'pointer' : 'default' }}
              title={char ? `点击查看${char.text.name}技能` : undefined}
            >
              <div className="player-avatar" style={{ background: colors.primary }}>
                {(p.name[0] || '?').toUpperCase()}
              </div>
              <div className="player-name">
                {p.name}
                {char && <span style={{ color: 'var(--color-text-muted)', fontWeight: 'normal', marginLeft: 4 }}>{char.text.name}</span>}
              </div>
              <div className="player-res">
                <span title="齿轮（胜利分）">⚙{p.resources.cogs}</span>
                <span title="金钱">${p.resources.gold}</span>
                <span title="收入">📈{p.resources.income}</span>
                <span title="选票">🗳{p.resources.votes}</span>
                <span title="罪恶">😈{p.resources.malice}</span>
                <span title="手牌">🂠{p.handCount}</span>
                {p.secretCount > 0 && <span title="秘密卡张数">🕵{p.secretCount}</span>}
              </div>
              <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {game.mayorId === p.id && <span className="tag-mayor">镇长</span>}
                {p.inJail && <span className="tag-jail">狱</span>}
                {p.skipNextTurn && <span className="tag-skip">跳</span>}
              </div>
            {/* 第二行：所在站点 / 永久卡 / 交锋战绩 / 监狱经验
                用户反馈"其他玩家的面板太小了，看不清别人的状态，状态应该更全一些" */}
            <div className="player-status-detail">
              <span className="ps-pos" title="所在站点">📍{positionLabel(p.position)}</span>
              {p.permanents.length > 0 && (
                <span
                  className="ps-perm"
                  title={`永久卡：${p.permanents.map((id) => CARD_BY_ID[id]?.text.name ?? id).join('、')}`}
                >
                  🃏{p.permanents.length}
                </span>
              )}
              {p.conflicts.total > 0 && (
                <span
                  className="ps-conflict"
                  title={`交锋战绩：参与 ${p.conflicts.total} 次 / 发起 ${p.conflicts.init} 次 / 胜 ${p.conflicts.won} 次`}
                >
                  ⚔{p.conflicts.won}/{p.conflicts.total}
                </span>
              )}
              {p.jailExperience > 0 && (
                <span className="ps-jailxp" title={`监狱经验 ${p.jailExperience}`}>🏅{p.jailExperience}</span>
              )}
            </div>
            </div>
          );
        })}
      </div>
      {detailCharId && (
        <CharacterDetailPopup charId={detailCharId} onClose={() => setDetailCharId(null)} />
      )}
    </>
  );
}

/** 非行动卡（厄运/监狱/暴乱）的简单详情弹窗 */
function SimpleCardDetail({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const mf = MISFORTUNE_CARDS.find((c) => c.id === cardId);
  const jc = JAIL_CARDS.find((c) => c.id === cardId);
  const cc = CHAOS_CARDS.find((c) => c.id === cardId);
  const card = mf ?? jc ?? cc;
  if (!card) return null;
  const kind = mf ? '厄运卡' : jc ? '监狱卡' : cc ? '暴乱卡牌' : '';
  return (
    <div className="card-detail-overlay" onClick={onClose}>
      <div className="card-detail" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="card-detail-header">
          <span className="card-detail-kind">{kind}</span>
        </div>
        <h3>{card.text?.name ?? cardId}</h3>
        {card.text?.description && (
          <div className="card-detail-rules">{card.text.description}</div>
        )}
        {card.text?.flavor && (
          <div className="card-detail-flavor">{card.text.flavor}</div>
        )}
        <div className="card-detail-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 角色技能详情弹窗 */
function CharacterDetailPopup({ charId, onClose }: { charId: string; onClose: () => void }) {
  const char = CHARACTER_BY_ID[charId];
  if (!char) return null;
  const abilities = characterAbilities(char);
  return (
    <div className="card-detail-overlay" onClick={onClose}>
      <div className="card-detail" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="card-detail-header">
          <span className="card-detail-kind">#{String(char.order).padStart(2, '0')}</span>
        </div>
        <h3>{char.text.name}</h3>
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 8 }}>{char.name}</div>
        {char.text.flavor && (
          <div className="card-detail-flavor" style={{ marginBottom: 12 }}>{char.text.flavor}</div>
        )}
        <div className="char-abilities" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {abilities.map((a, i) => (
            <div key={i} className="char-ability-item" style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--color-bg-secondary)', borderRadius: 4 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{a.section}</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{a.name}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{a.description}</div>
            </div>
          ))}
          {!abilities.length && (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>（无技能数据）</div>
          )}
        </div>
        <div className="card-detail-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
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

  // 构建卡牌名→ID映射（用显示名 text.name，不是内部名 name）
  // 包含行动卡、厄运卡、监狱卡、暴乱卡牌——日志里都可能提到
  const cardNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [id, card] of Object.entries(CARD_BY_ID)) {
      if (card.text?.name) map[card.text.name] = id;
    }
    for (const card of MISFORTUNE_CARDS) {
      if (card.text?.name) map[card.text.name] = card.id;
    }
    for (const card of JAIL_CARDS) {
      if (card.text?.name) map[card.text.name] = card.id;
    }
    for (const card of CHAOS_CARDS) {
      if (card.text?.name) map[card.text.name] = card.id;
    }
    return map;
  }, []);

  // 按名称长度降序排列，避免短名先匹配到长名的子串
  const sortedNames = useMemo(
    () => Object.keys(cardNameMap).sort((a, b) => b.length - a.length),
    [cardNameMap],
  );

  // 把日志文本中的卡牌名渲染为可点击span
  function renderText(text: string) {
    const parts: React.ReactNode[] = [];
    let remaining = text;
    let key = 0;
    while (remaining.length > 0) {
      let found = false;
      for (const name of sortedNames) {
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
        CARD_BY_ID[detailCardId] ? (
          <CardDetail cardId={detailCardId} onClose={() => setDetailCardId(null)} canPlay={false} />
        ) : (
          <SimpleCardDetail cardId={detailCardId} onClose={() => setDetailCardId(null)} />
        )
      )}
    </>
  );
}
