import { useState } from 'react';
import { useGameStore } from '../store/game.js';
import { BoardView } from '../components/BoardView.js';
import { ResourcePanel, PlayerList, LogBox, PermanentPanel } from '../components/Hud.js';
import { Card, CardDetail } from '../components/Card.js';
import { CARD_BY_ID, CHAOS_CARDS } from '@gremlins/shared';
import type { ActionCard } from '@gremlins/shared';
import '../styles/game.css';
import '../styles/cards.css';

export function GamePage() {
  const game = useGameStore((s) => s.game);
  const selfId = useGameStore((s) => s.selfId);
  const prompt = useGameStore((s) => s.prompt);
  const showCardDetail = useGameStore((s) => s.showCardDetail);
  const setCardDetail = useGameStore((s) => s.setCardDetail);
  const selectedCardId = useGameStore((s) => s.selectedCardId);
  const playCard = useGameStore((s) => s.playCard);
  const playChaosCard = useGameStore((s) => s.playChaosCard);
  const skipPlay = useGameStore((s) => s.skipPlay);
  const choose = useGameStore((s) => s.choose);
  const doOption = useGameStore((s) => s.doOption);
  const jailTurn = useGameStore((s) => s.jailTurn);
  const leaveRoom = useGameStore((s) => s.leaveRoom);
  const syncGame = useGameStore((s) => s.syncGame);
  const movePreview = useGameStore((s) => s.movePreview);
  const startMovePreview = useGameStore((s) => s.startMovePreview);
  const selectMoveDest = useGameStore((s) => s.selectMoveDest);
  const confirmMove = useGameStore((s) => s.confirmMove);
  const cancelMovePreview = useGameStore((s) => s.cancelMovePreview);

  const [paused, setPaused] = useState(false);

  if (!game) {
    return (
      <div className="game">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <button onClick={syncGame}>同步游戏状态</button>
          <button onClick={leaveRoom}>返回</button>
        </div>
      </div>
    );
  }

  const myPlayer = game.players.find((p) => p.id === selfId);
  const isMyTurn = game.currentTurnPlayerId === selfId;
  const myHand = myPlayer?.hand ?? [];
  const chaosEnabled = game.riotCardsEnabled !== false;

  const playableCardIds = new Set(
    prompt?.type === 'select_move_card'
      ? (prompt.options ?? [])
      : prompt?.type === 'play_card_or_skip'
        ? (prompt.options ?? [])
        : [],
  );

  return (
    <div className="game">
      {/* 顶栏 */}
      <div className="game-topbar">
        <div className="game-topbar-left">
          <button onClick={leaveRoom}>退出</button>
          <span className="turn-info">
            回合 <b>#{game.turn}</b>
            {game.nextElectionTurn - game.turn > 0 && (
              <span style={{ marginLeft: 8, color: 'var(--color-text-muted)' }}>
                · 距选举 {game.nextElectionTurn - game.turn}
              </span>
            )}
          </span>
        </div>
        <div className="game-topbar-right">
          {game.mayorId && (
            <span style={{ color: 'var(--color-gold)', fontSize: 12, marginRight: 8 }}>
              镇长：{game.players.find((p) => p.id === game.mayorId)?.name}
            </span>
          )}
          <button
            className={`pause-btn ${paused ? 'active' : ''}`}
            onClick={() => setPaused(!paused)}
            title={paused ? '继续' : '暂停'}
          >
            {paused ? '▶' : '⏸'}
          </button>
        </div>
      </div>

      {/* 暂停遮罩 */}
      {paused && (
        <div className="pause-overlay" onClick={() => setPaused(false)}>
          <div className="pause-content">
            <h2>已暂停</h2>
            <p>点击任意位置继续</p>
          </div>
        </div>
      )}

      {/* 主体 */}
      <div className="game-main">
        {/* 左侧：暴乱卡牌面板 */}
        {chaosEnabled && (game.chaosPool?.length ?? 0) > 0 && (
          <div className="game-chaos-side">
            <details>
              <summary>暴乱卡牌（{game.chaosPool!.length} 张剩余）</summary>
              <div className="chaos-card-list">
                {game.chaosPool!.map((c) => (
                  <button
                    key={c.id}
                    className={`chaos-card-btn ${c.playable ? '' : 'disabled'}`}
                    disabled={!c.playable}
                    title={c.description || `${c.cost} → ${c.gain}`}
                    onClick={() => {
                      const needPerm = /SacrificePermanent/.test(
                        JSON.stringify(CHAOS_CARDS.find((x) => x.id === c.id)?.actions ?? []),
                      );
                      if (needPerm) {
                        const perm = myPlayer?.permanents?.[0];
                        if (!perm) return;
                        if (!window.confirm(
                          `「${c.name}」需要丢弃一张激活的永久卡，确认丢弃第一张并打出？`,
                        )) return;
                        playChaosCard(c.id, perm);
                      } else {
                        playChaosCard(c.id);
                      }
                    }}
                  >
                    <span className="chaos-card-name">{c.name}</span>
                    <span className="chaos-cost">{c.cost} → {c.gain}</span>
                    {!c.playable && c.reason && (
                      <span className="option-reason">{c.reason}</span>
                    )}
                  </button>
                ))}
              </div>
            </details>
          </div>
        )}

        {/* 棋盘 */}
        <div className="game-board-wrap">
          <BoardView
            players={game.players}
            myPlayer={myPlayer}
            mapId={game.mapId}
            moveDestTiles={movePreview?.destinations}
            selectedDestTile={movePreview?.selectedDest ?? undefined}
            pathTiles={
              movePreview && movePreview.selectedDest != null
                ? movePreview.destPaths.get(movePreview.selectedDest)
                : undefined
            }
            onTileClick={(tileId) => {
              if (movePreview) selectMoveDest(tileId);
            }}
          />

          {/* 操作提示面板 */}
          {isMyTurn && movePreview ? (
            <div className="action-panel">
              <span className="action-prompt">
                {movePreview.destinations.length === 0
                  ? '该卡无可达目的地'
                  : movePreview.selectedDest != null
                    ? '已选定目的地，确认移动？'
                    : '点击地图选择目的地'}
              </span>
              <button className="primary" onClick={confirmMove} disabled={movePreview.selectedDest == null}>
                确认移动
              </button>
              <button onClick={cancelMovePreview}>取消</button>
            </div>
          ) : isMyTurn && prompt ? (
            <div className="action-panel">
              <span className="action-prompt">{prompt.message}</span>

              {/* 挂起决策：选对手/选地点/选方向… */}
              {prompt.type === 'choose' && (
                <div className="choice-list">
                  {(prompt.choices ?? []).map((c) => (
                    <button key={c.value} onClick={() => choose(prompt.type, [c.value])}>
                      {c.label}
                    </button>
                  ))}
                  {!prompt.choices?.length && (
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>无可用选项</span>
                  )}
                </div>
              )}

              {/* 可选动作：站点/建筑的主动行为 */}
              {(prompt.type === 'select_move_card' || prompt.type === 'play_card_or_skip')
                && (prompt.optionalActions?.length ?? 0) > 0 && (
                <div className="option-list">
                  {prompt.optionalActions!.map((o) => (
                    <button
                      key={o.id}
                      className={o.affordable === false ? '' : 'option-btn'}
                      disabled={o.affordable === false}
                      title={o.description ?? ''}
                      onClick={() => {
                        if (o.needsTarget) {
                          const others = game.players.filter((p) => p.id !== selfId && !p.isAI);
                          const target = others[0] ?? game.players.find((p) => p.id !== selfId);
                          if (target) doOption(o.id, target.id);
                        } else {
                          doOption(o.id);
                        }
                      }}
                    >
                      {o.label}
                      {o.affordable === false && o.reason && (
                        <span className="option-reason">（{o.reason}）</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* 狱中：服刑 */}
              {prompt.type === 'select_move_card' && myPlayer?.inJail && (
                <button className="primary" onClick={jailTurn}>服刑（抽监狱卡）</button>
              )}

              {/* 移动后：跳过打牌 = 自动换人 */}
              {prompt.type === 'play_card_or_skip' && (
                <button onClick={skipPlay}>跳过，结束回合</button>
              )}
            </div>
          ) : null}
        </div>

        {/* 右侧栏 */}
        <div className="game-sidebar">
          <div className="game-sidebar-section">
            <h4>我的状态</h4>
            <ResourcePanel game={game} myPlayer={myPlayer} />
          </div>
          {myPlayer && (myPlayer.permanents?.length ?? 0) > 0 && (
            <div className="game-sidebar-section">
              <h4>装备（永久卡牌）</h4>
              <PermanentPanel permanents={myPlayer.permanents!} />
            </div>
          )}
          <div className="game-sidebar-section">
            <h4>玩家</h4>
            <PlayerList game={game} mySocketId={selfId} />
          </div>
          <div className="game-sidebar-section log-section" style={{ flex: 1 }}>
            <h4>日志</h4>
            <LogBox game={game} mySocketId={selfId} />
          </div>
        </div>
      </div>

      {/* 手牌 */}
      <div className="hand">
        {myHand.map((cardId) => {
          const playable = isMyTurn && playableCardIds.has(cardId);
          const isSelected = selectedCardId === cardId;
          const isMovePhase = prompt?.type === 'select_move_card';
          const isPlayPhase = prompt?.type === 'play_card_or_skip';
          // 移动后：只有能在当前格打出（类型匹配+付得起）的牌才高亮
          const highlight = isPlayPhase && playable;
          return (
            <Card
              key={cardId}
              cardId={cardId}
              selected={isSelected}
              disabled={isMyTurn && !playable}
              highlight={highlight}
              onLongPress={() => setCardDetail(cardId)}
              onClick={() => {
                if (isMyTurn && isMovePhase && playable) {
                  startMovePreview(cardId);
                } else if (isMyTurn && isPlayPhase && playable) {
                  if (requireTarget(cardId)) {
                    setCardDetail(cardId);
                  } else {
                    playCard(cardId);
                  }
                } else {
                  setCardDetail(cardId);
                }
              }}
            />
          );
        })}
        {myHand.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', padding: 20 }}>无手牌</div>
        )}
      </div>

      {/* 卡牌详情 */}
      {showCardDetail && (
        <CardDetail
          cardId={showCardDetail}
          onClose={() => setCardDetail(null)}
          canPlay={
            isMyTurn &&
            (prompt?.type === 'play_card_or_skip' || prompt?.type === 'select_move_card') &&
            playableCardIds.has(showCardDetail)
          }
          playLabel={prompt?.type === 'select_move_card' ? '用于移动' : '打出'}
          requireTarget={prompt?.type === 'play_card_or_skip' && requireTarget(showCardDetail)}
          targetOptions={game.players
            .filter((p) => p.id !== selfId)
            .map((p) => ({ id: p.id, name: p.name }))}
          onPlay={(targetId) => {
            const cardId = showCardDetail;
            setCardDetail(null);
            if (prompt?.type === 'select_move_card') {
              startMovePreview(cardId);
            } else if (prompt?.type === 'play_card_or_skip') {
              playCard(cardId, targetId);
            }
          }}
        />
      )}
    </div>
  );
}

function requireTarget(cardId: string): boolean {
  const card = CARD_BY_ID[cardId] as ActionCard | undefined;
  if (!card) return false;
  const selectors = new Set(['SelectOpponent', 'SelectEvil', 'SelectGovernor']);
  return card.actions.some((a) => selectors.has(a.type));
}
