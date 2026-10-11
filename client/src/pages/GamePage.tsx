import { useEffect, useState } from 'react';
import { useIsMobile } from '../hooks/useMediaQuery.js';
import { useGameStore } from '../store/game.js';
import { BoardView } from '../components/BoardView.js';
import { ResourcePanel, PlayerList, LogBox, PermanentPanel, SimpleCardDetail } from '../components/Hud.js';
import { Card, CardDetail } from '../components/Card.js';
import { BOARD_VIEW, CARD_BY_ID, CHAOS_CARDS, JAIL_CARDS, displayCardRules, getBoardView } from '@gremlins/shared';
import type { ActionCard } from '@gremlins/shared';
import '../styles/game.css';
import '../styles/cards.css';

/**
 * 数值输入（主要用于**交锋出价**）。
 *
 * 原版交锋让玩家自己填金额、上限是自己的金钱，不是从固定档位里挑
 * （用户报的 bug #4）。默认填上限、可直接改小。
 */
function NumericBid({
  min, max, unit, onSubmit,
}: {
  min: number; max: number; unit: string;
  onSubmit: (v: number) => void;
}) {
  const [value, setValue] = useState(String(max));
  const num = Number(value);
  const valid = Number.isFinite(num) && num >= min && num <= max;
  return (
    <div className="numeric-bid" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        // 手机上弹**数字键盘**（否则要切键盘才能输金额）
        inputMode="numeric"
        enterKeyHint="done"
        // 不用固定 90px：窄屏上和按钮挤在一行会溢出
        style={{ width: 'clamp(64px, 22vw, 90px)' }}
        aria-label="出价金额"
      />
      <span style={{ fontSize: 12 }}>{unit}</span>
      <button disabled={!valid} onClick={() => onSubmit(num)}>
        出价
      </button>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        （{min}–{max}）
      </span>
    </div>
  );
}

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

  // ── 移动端布局 ──
  // 手机上棋盘两侧的"暴乱卡牌 / 状态侧栏"必须让位给棋盘，改成可开合的浮层，
  // 否则棋盘被挤到只剩几十像素（用户反馈"适配不好、信息被遮挡"）。
  const isMobile = useIsMobile();
  const [drawer, setDrawer] = useState<null | 'info' | 'chaos'>(null);
  // 传送类卡牌选中的目的地（在地图上点选，再点"确认传送"）
  const [teleportDest, setTeleportDest] = useState<string | null>(null);
  // 切到窄屏时收起浮层，避免残留
  useEffect(() => {
    if (!isMobile) setDrawer(null);
  }, [isMobile]);

  // ── 传送目的地：换一张卡/换一个挂起时必须重置 ──
  //
  // `teleportDest` 是本地选择状态。若不随提示变化清空，会出现两种错：
  //  ① 上一张卡选的地点残留到下一张（哪怕新卡的目的地集合完全不同）
  //  ② "确认传送"按钮在还没选就被点（用的是陈旧值）
  // 用 prompt 的消息 + 目的地集合作为依赖：只要提示换了就清空重选。
  const placeKey = prompt?.placeOptions?.join(',') ?? '';
  useEffect(() => {
    setTeleportDest(null);
  }, [placeKey, prompt?.message]);

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
      ? (prompt.options ?? [])  // Move 阶段：全部手牌可移动
      : prompt?.type === 'play_card_or_skip' && (prompt.options ?? []).length > 0
        ? (prompt.options ?? [])  // UseCard 阶段：只有列出的牌可打
        : [],  // UseCell 阶段或无提示：无牌可打
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
          {/* 手机上侧栏是抽屉：给一个明确的入口，否则玩家看不到自己和别人的状态 */}
          {isMobile && (
            <button
              className={`pause-btn ${drawer === 'info' ? 'active' : ''}`}
              onClick={() => setDrawer(drawer === 'info' ? null : 'info')}
              title="我的状态 / 玩家 / 日志"
            >
              ☰
            </button>
          )}
          {isMobile && chaosEnabled && (game.chaosPool?.length ?? 0) > 0 && (
            <button
              className={`pause-btn ${drawer === 'chaos' ? 'active' : ''}`}
              onClick={() => setDrawer(drawer === 'chaos' ? null : 'chaos')}
              title="暴乱卡牌"
            >
              ◆
            </button>
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
      <div className={`game-main${isMobile ? ' mobile' : ''}`}>
        {/* 左侧：暴乱卡牌面板 */}
        {chaosEnabled && (game.chaosPool?.length ?? 0) > 0 && (
          <div className={`game-chaos-side${isMobile && drawer === 'chaos' ? ' open' : ''}${isMobile ? ' mobile-left' : ''}`}>
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
                    <span className="chaos-card-name">
                      {CHAOS_CARDS.find((x) => x.id === c.id)?.special === true ? '⚙ ' : ''}
                      {c.name}
                    </span>
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
            moveDestTiles={movePreview?.destinations ?? prompt?.placeOptions}
            selectedDestTile={movePreview?.selectedDest ?? teleportDest ?? undefined}
            pathTiles={
              movePreview && movePreview.selectedDest != null
                ? movePreview.destPaths.get(movePreview.selectedDest)
                : undefined
            }
            onTileClick={(tileId) => {
              if (movePreview) { selectMoveDest(tileId); return; }
              // 传送类卡牌：点地图选目的地（只接受服务端给的合法目的地）
              if (prompt?.placeOptions?.includes(tileId)) setTeleportDest(tileId);
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
                  {/* ── 抽监狱牌：单独渲染成"卡牌"而不是一行按钮 ──
                      用户反馈：抽到「倒爷」看不到牌、也没法点开预览，
                      只能在日志里看。这里列出候选卡的**完整规则**，
                      并支持点「详情」看大图；选中即服刑。
                      （`jailPick` 的 kind 在 choices 里以 cardId 为 value） */}
                  {isTeleportPick(prompt) ? (
                    // ── 传送类卡牌：在地图上点选目的地 ──
                    // 用户要求：不要把"所有地点"列成一串任选，应该
                    // **在棋盘上高亮合法目的地 → 点击 → 确认传送**。
                    // 合法目的地由服务端给出（`placeOptions`），
                    // 所以点地图上的非高亮格不会生效。
                    <div className="teleport-pick">
                      <span className="teleport-hint">
                        {teleportDest
                          ? `已选：${tileLabel(teleportDest)}`
                          : '请在地图上点击高亮的地点'}
                      </span>
                      <button
                        className="primary"
                        disabled={!teleportDest}
                        onClick={() => {
                          const d = teleportDest;
                          setTeleportDest(null);
                          choose(prompt.type, [d!]);
                        }}
                      >
                        确认传送
                      </button>
                    </div>
                  ) : isJailPick(prompt) ? (
                    <div className="jail-pick-list">
                      {jailCandidates(prompt).map((c) => (
                        <div key={c.id} className="jail-pick-card">
                          <div className="jail-pick-main">
                            <div className="jail-pick-name">{c.name}</div>
                            <div className="jail-pick-rule">{c.rule}</div>
                          </div>
                          <div className="jail-pick-actions">
                            <button className="jail-pick-more" onClick={() => setCardDetail(c.id)}>
                              详情
                            </button>
                            <button
                              className="primary"
                              onClick={() => choose(prompt.type, [c.id])}
                            >
                              选这张
                            </button>
                          </div>
                        </div>
                      ))}
                      {prompt.choices?.find((c) => c.value === 'jailDecline') && (
                        <button
                          className="jail-pick-decline"
                          onClick={() => choose(prompt.type, ['jailDecline'])}
                        >
                          全部拒绝（刑期 −1，+1 罪恶）
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* 数值输入（交锋出价）：原版是自己填金额，不是从档位里挑 */}
                      {prompt.numeric && (
                        <NumericBid
                          min={prompt.numeric.min}
                          max={prompt.numeric.max}
                          unit={prompt.numeric.unit ?? ''}
                          onSubmit={(v) => choose(prompt.type, [String(v)])}
                        />
                      )}
                      {(prompt.choices ?? []).map((c) => (
                        <button key={c.value} onClick={() => choose(prompt.type, [c.value])}>
                          {c.label}
                        </button>
                      ))}
                    </>
                  )}
                  {!prompt.choices?.length && !prompt.numeric && (
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>无可用选项</span>
                  )}
                </div>
              )}

              {/* 被查看的对方手牌（a043 搜身 / a046 清剿行动 / a151 告密者…） */}
              {game.revealedHand && (
                <div className="revealed-hand">
                  <div className="revealed-hand-title">
                    🔍 {game.revealedHand.ownerName} 的手牌
                    （{game.revealedHand.cardIds.length} 张）
                  </div>
                  <div className="revealed-hand-cards">
                    {game.revealedHand.cardIds.map((id) => (
                      <span key={id} className="revealed-hand-card" title={CARD_BY_ID[id]?.text.name ?? id}>
                        {CARD_BY_ID[id] ? displayCardRules(CARD_BY_ID[id] as ActionCard).slice(0, 18) : id}
                      </span>
                    ))}
                    {game.revealedHand.cardIds.length === 0 && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>（没有手牌）</span>
                    )}
                  </div>
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

              {/* 结束本阶段 / 结束回合。
                  用户要求（bug #9）：无可操作步骤时**自动跳过**，只有"可选"的
                  步骤才需要这个按钮 —— 服务端用 canEndPhase 标明。 */}
              {prompt.type === 'play_card_or_skip' && prompt.canEndPhase && (
                <button onClick={skipPlay}>跳过，结束回合</button>
              )}
            </div>
          ) : null}
        </div>

        {/* 右侧栏 */}
        <div className={`game-sidebar${isMobile && drawer === 'info' ? ' open' : ''}`}>
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

      {/* 移动端抽屉遮罩：点空白处收起 */}
      {isMobile && drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(null)} />
      )}

      {/* 手牌 */}
      <div className="hand">
        {myHand.map((cardId) => {
          const isMovePhase = prompt?.type === 'select_move_card';
          const isPlayPhase = prompt?.type === 'play_card_or_skip';
          const playable = isMyTurn && (
            (isMovePhase && playableCardIds.has(cardId)) ||
            (isPlayPhase && playableCardIds.has(cardId))
          );
          const isSelected = selectedCardId === cardId;
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
        // 行动卡走 CardDetail（能打出）；监狱/厄运/暴乱卡走 SimpleCardDetail。
        // `CardDetail` 对非行动卡会 return null（CARD_BY_ID 里没有它们），
        // 于是"抽到倒爷点详情"什么都不显示 —— 用户反馈的正是这个。
        CARD_BY_ID[showCardDetail] ? (
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
        ) : (
          <SimpleCardDetail cardId={showCardDetail} onClose={() => setCardDetail(null)} />
        )
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

/** 这个挂起是不是"抽监狱牌，选一张" */
function isJailPick(prompt: { cardIds?: string[] }): boolean {
  return (prompt.cardIds?.length ?? 0) > 0;
}

/**
 * 这个挂起是不是"选传送目的地"。
 *
 * 判据是服务端给的 `placeOptions`（棋盘地点 id 列表）—— 有了它就在
 * **地图上高亮点选**，而不是把地点列成一串按钮（用户要求）。
 */
function isTeleportPick(prompt: { placeOptions?: string[] }): boolean {
  return (prompt.placeOptions?.length ?? 0) > 0;
}

/** 棋盘格 id → 可读站名（用于"已选：xxx"提示） */
function tileLabel(tileId: string): string {
  const view = getBoardView() ?? BOARD_VIEW;
  const t = view?.byId?.get(tileId);
  return t?.label || t?.cellType || tileId;
}

/**
 * 把"抽监狱牌"的候选项整理成可渲染的卡牌。
 *
 * 为什么不直接用 `prompt.choices`：那些 label 是
 * `「倒爷」——丢弃1张卡牌。` 这种"名字+规则"拼成的长文本，
 * 塞进按钮里既看不清也没法点开看详情（用户反馈）。
 * 这里取卡牌本体的名称与规则，交给卡牌式 UI 渲染。
 */
function jailCandidates(prompt: { cardIds?: string[] }): Array<{
  id: string; name: string; rule: string;
}> {
  return (prompt.cardIds ?? []).map((id) => {
    const c = JAIL_CARDS.find((x) => x.id === id);
    return {
      id,
      name: c?.text.name ?? id,
      rule: c ? displayCardRules(c) : '',
    };
  });
}
