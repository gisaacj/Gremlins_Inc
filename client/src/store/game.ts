import { create } from 'zustand';
import type {
  LobbyState, SerializedGameState, PlayerPrompt,
} from '@gremlins/shared';
import {
  CARD_BY_ID, CHARACTER_BY_ID, BOARD_VIEW, getBoardView,
  computeReachableTiles, cardMoveSteps, isReverseMoveCard, CHARACTERS,
} from '@gremlins/shared';
import { LocalGame, runAIPlayers } from '@gremlins/shared/engine';
import { getSocket } from '../net/socket.js';
import { loggers } from '../utils/logger.js';

const log = loggers.store;

/** 单机模式下"我"的玩家 id */
const MY_ID = 'me';

/**
 * 单机模式：执行一步本地动作 → 跑 AI → 刷新视图与提示。
 *
 * 联机模式由服务端广播状态，这里主动刷新是因为没有服务端。
 */
function withLocal(
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
  fn: (g: LocalGame) => unknown,
): void {
  const g = get().local;
  if (!g) return;
  try {
    fn(g);
    g.runAI(); // 让 AI 依次行动，直到轮到人类或结束
  } catch (e) {
    log.error(`单机动作失败: ${(e as Error).message}`);
    set({ error: { code: 'LOCAL_ERROR', message: (e as Error).message, ts: Date.now() } });
    return;
  }
  refreshLocal(get, set);
}

/** 把本地对局状态推给 UI */
function refreshLocal(
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
): void {
  const g = get().local;
  if (!g) return;
  const view = g.viewFor(MY_ID);
  set({
    game: view,
    prompt: g.promptFor(MY_ID),
    winnerId: g.winnerId ?? null,
    view: g.phase === 'game_over' ? 'game_over' : 'game',
    movePreview: null,
  });
}

interface ChatMessage {
  playerId: string;
  name: string;
  text: string;
  ts: number;
}

interface MovePreview {
  cardId: string;
  /** 可达目的地 tile id 列表（原版 UIN 字符串） */
  destinations: string[];
  /** 目的地 -> 途经路径（含终点，不含起点） */
  destPaths: Map<string, string[]>;
  /** 已选定的目的地 */
  selectedDest: string | null;
}

interface GameStore {
  // 连接状态
  connected: boolean;
  mySocketId: string;

  // 大厅
  view: 'menu' | 'lobby' | 'character_select' | 'game' | 'game_over';
  lobby: LobbyState | null;
  myName: string;
  roomId: string;

  /**
   * 对局模式。
   *  - `online`：走 socket.io 连服务端（局域网联机）
   *  - `local`：浏览器内直接跑引擎（单机，无需服务端）
   */
  mode: 'online' | 'local';
  /** 单机对局实例（mode==='local' 时有效） */
  local: LocalGame | null;
  /**
   * 我在对局里的玩家 id。
   * 联机是 socket id，单机是固定 `'me'`——UI 一律用这个取"自己"。
   */
  selfId: string;

  // 游戏
  game: SerializedGameState | null;
  prompt: PlayerPrompt | null;
  logs: ChatMessage[];
  error: { code: string; message: string; ts: number } | null;
  winnerId: string | null;

  // UI
  selectedCardId: string | null;
  selectedTargetId: string | null;
  showCardDetail: string | null;
  /** 移动预览：选定卡牌后高亮可达目的地 */
  movePreview: MovePreview | null;

  // 动作
  setView: (v: GameStore['view']) => void;
  setMyName: (n: string) => void;
  setRoomId: (id: string) => void;
  setLobby: (s: LobbyState | null) => void;
  setGame: (g: SerializedGameState | null) => void;
  setPrompt: (p: PlayerPrompt | null) => void;
  setError: (e: { code: string; message: string } | null) => void;
  addChat: (m: ChatMessage) => void;
  selectCard: (id: string | null) => void;
  selectTarget: (id: string | null) => void;
  setCardDetail: (id: string | null) => void;
  startMovePreview: (cardId: string) => void;
  selectMoveDest: (tileId: string) => void;
  confirmMove: () => void;
  cancelMovePreview: () => void;

  // 单机
  /**
   * 开一局单机：浏览器内直接跑引擎 + AI，**不需要服务端**。
   *
   * AI 角色从玩家未选的角色里随机取（按行动顺序排序，与联机一致）。
   */
  startLocalGame: (opts: {
    playerName: string;
    characterId: string;
    aiCount: number;
    targetCogs: number;
  }) => void;

  // 网络
  init: () => void;
  createRoom: (name: string, targetCogs?: number) => Promise<void>;
  joinRoom: (roomId: string, name: string) => Promise<void>;
  leaveRoom: () => void;
  setReady: (ready: boolean) => void;
  selectCharacter: (charId: string) => void;
  addAI: () => void;
  updateConfig: (patch: Partial<LobbyState['config']>) => void;
  startGame: () => void;

  // 游戏动作
  selectMoveCard: (cardId: string) => void;
  playCard: (cardId: string, targetId?: string) => void;
  skipPlay: () => void;
  /** 回答服务端挂起的决策（选对手 / 选地点 / 选方向…） */
  choose: (kind: string, values: string[]) => void;
  /** 执行可选动作（投资、卖选票、打工、赌博…） */
  doOption: (optionId: string, targetId?: string) => void;
  /** 结束自己的回合 */
  endTurn: () => void;
  /** 狱中服刑：抽监狱卡 */
  jailTurn: () => void;
  syncGame: () => void;
  sendChat: (text: string) => void;
}

export const useGameStore = create<GameStore>((set, get) => ({
  connected: false,
  mySocketId: '',
  view: 'menu',
  lobby: null,
  myName: '',
  roomId: '',
  mode: 'online',
  local: null,
  selfId: '',
  game: null,
  prompt: null,
  logs: [],
  error: null,
  winnerId: null,
  selectedCardId: null,
  selectedTargetId: null,
  showCardDetail: null,
  movePreview: null,

  setView: (v) => set({ view: v }),
  setMyName: (n) => set({ myName: n }),
  setRoomId: (id) => set({ roomId: id }),
  setLobby: (s) => set({ lobby: s, view: s ? (s.phase === 'character_select' ? 'character_select' : 'lobby') : 'menu' }),
  setGame: (g) => set({ game: g, view: g ? (g.phase === 'game_over' ? 'game_over' : 'game') : 'menu', winnerId: g?.winnerId ?? null, movePreview: null }),
  setPrompt: (p) => set({ prompt: p, movePreview: null }),
  setError: (e) => set({ error: e ? { ...e, ts: Date.now() } : null }),
  addChat: (m) => set((s) => ({ logs: [...s.logs.slice(-199), m] })),
  selectCard: (id) => set({ selectedCardId: id }),
  selectTarget: (id) => set({ selectedTargetId: id }),
  setCardDetail: (id) => set({ showCardDetail: id }),

  /** 开一局单机：浏览器内直接跑引擎 + AI，不需要服务端 */
  startLocalGame: (opts) => {
    const { playerName, characterId, aiCount, targetCogs } = opts;
    const used = new Set([characterId]);
    const seats = [
      { id: MY_ID, name: playerName || '我', isAI: false, characterId },
    ];
    const pool = [...CHARACTERS].filter((c) => !used.has(c.id));
    // 洗一下，避免每次都是同一批 AI 角色
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let i = 0; i < aiCount && i < pool.length; i++) {
      seats.push({ id: `ai${i + 1}`, name: `AI ${i + 1}`, isAI: true, characterId: pool[i].id });
    }

    const game = new LocalGame({
      roomId: 'local',
      seats,
      targetScore: targetCogs,
      // 共享 AI 策略（与联机服同一套）
      think: (state) => { runAIPlayers(state); },
    });

    log.info(`单机开局 我=${characterId} AI=${seats.length - 1} 目标=${targetCogs}`);
    set({ mode: 'local', local: game, roomId: 'local', myName: seats[0].name, selfId: MY_ID });
    // 若开局轮到 AI，先让它行动
    game.runAI();
    refreshLocal(get, set);
  },

  init: () => {
    const socket = getSocket();
    if (socket.connected) {
      set({ connected: true, mySocketId: socket.id ?? '', selfId: socket.id ?? '' });
    }
    socket.on('connect', () => {
      log.info(`connect socketId=${socket.id}`);
      set({ connected: true, mySocketId: socket.id ?? '', selfId: socket.id ?? '' });
    });
    socket.on('disconnect', () => {
      log.warn('disconnect');
      set({ connected: false });
    });
    socket.on('room:state', (state) => {
      log.info(`recv room:state roomId=${state.roomId} phase=${state.phase} players=${state.players.length}`);
      set({ lobby: state, roomId: state.roomId, view: state.phase === 'character_select' ? 'character_select' : 'lobby' });
    });
    socket.on('room:character_select', (state) => {
      log.info('recv room:character_select');
      set({ lobby: state, view: 'character_select' });
    });
    socket.on('game:start', () => {
      log.info('recv game:start');
      set({ view: 'game' });
    });
    socket.on('game:state', (g) => {
      log.info(`recv game:state turn=${g.turn} phase=${g.phase} turnPhase=${g.turnPhase} cur=${g.currentTurnPlayerId.slice(0,8)}`);
      set({ game: g, view: g.phase === 'game_over' ? 'game_over' : 'game', winnerId: g.winnerId ?? null });
    });
    socket.on('game:patch', (patch) => {
      log.debug('recv game:patch', patch);
      const cur = get().game;
      if (cur) set({ game: { ...cur, ...patch } as any });
    });
    socket.on('game:prompt', (p) => {
      log.info(`recv game:prompt type=${p?.type} msg="${p?.message?.slice(0, 50)}"`);
      set({ prompt: p });
    });
    socket.on('game:log', (entry) => {
      log.debug(`recv game:log turn=${entry.turn}: ${entry.text}`);
    });
    socket.on('game:over', (winnerId) => {
      log.info(`recv game:over winner=${winnerId}`);
      set({ winnerId, view: 'game_over' });
    });
    socket.on('error', (msg) => {
      log.error(`recv error code=${msg.code} msg=${msg.message}`);
      set({ error: { code: msg.code, message: msg.message, ts: Date.now() } });
    });
    socket.on('chat:recv', (msg) => {
      log.debug(`recv chat:recv from=${msg.name}: ${msg.text}`);
      get().addChat(msg);
    });
  },

  createRoom: async (name, targetCogs = 30) => {
    const socket = getSocket();
    set({ myName: name });
    log.info(`createRoom name=${name} targetCogs=${targetCogs}`);
    await new Promise<void>((resolve, reject) => {
      socket.emit('room:create', { name, config: { targetCogs } }, (res) => {
        log.debug(`room:create ack ok=${res.ok} roomId=${res.roomId}`);
        if (res.ok && res.roomId) {
          set({ roomId: res.roomId });
          socket.emit('room:join', { roomId: res.roomId, name }, (r) => {
            log.debug(`room:join ack ok=${r.ok}`);
            if (r.ok) resolve();
            else reject(new Error(r.error));
          });
        } else {
          reject(new Error(res.error));
        }
      });
    });
  },

  joinRoom: async (roomId, name) => {
    const socket = getSocket();
    set({ myName: name, roomId });
    log.info(`joinRoom roomId=${roomId} name=${name}`);
    await new Promise<void>((resolve, reject) => {
      socket.emit('room:join', { roomId, name }, (res) => {
        log.debug(`room:join ack ok=${res.ok}`);
        if (res.ok) resolve();
        else reject(new Error(res.error));
      });
    });
  },

  leaveRoom: () => {
    log.info('leaveRoom');
    // 单机模式没有服务端可退，直接清本地对局
    if (get().mode === 'online') getSocket().emit('room:leave');
    set({
      lobby: null, game: null, view: 'menu', roomId: '',
      local: null, mode: 'online', selfId: '', prompt: null, winnerId: null,
      selectedCardId: null, selectedTargetId: null, movePreview: null,
    });
  },

  setReady: (ready) => {
    log.info(`emit room:ready ready=${ready}`);
    getSocket().emit('room:ready', { ready });
  },

  selectCharacter: (charId) => {
    log.info(`emit room:select_character charId=${charId}`);
    getSocket().emit('room:select_character', { characterId: charId });
  },

  addAI: () => {
    log.info('emit room:add_ai');
    getSocket().emit('room:add_ai');
  },

  updateConfig: (patch) => {
    log.info('emit room:update_config', patch);
    getSocket().emit('room:update_config', patch);
  },

  startGame: () => {
    log.info('emit room:start');
    getSocket().emit('room:start');
  },

  selectMoveCard: (cardId) => {
    set({ selectedCardId: cardId });
    log.info(`emit game:select_move_card cardId=${cardId}`);
    getSocket().emit('game:select_move_card', { cardId });
  },

  startMovePreview: (cardId) => {
    const { game, selfId } = get();
    if (!game) return;
    const me = game.players.find((p) => p.id === selfId);
    if (!me) return;
    const card = CARD_BY_ID[cardId];
    if (!card) return;
    const steps = cardMoveSteps(cardId);
    const reverse = isReverseMoveCard(cardId);
    // 用真实棋盘拓扑遍历（地图取自服务端下发的 mapId）
    const board = game.mapId ? getBoardView(game.mapId) : BOARD_VIEW;
    const destPaths = computeReachableTiles(board, me.position, steps, reverse);
    const destinations = [...destPaths.keys()];
    log.info(`movePreview cardId=${cardId} steps=${steps} from=${me.position} dests=${destinations.length}`);
    set({
      selectedCardId: cardId,
      movePreview: {
        cardId,
        destinations,
        destPaths,
        selectedDest: destinations.length === 1 ? destinations[0] : null,
      },
    });
  },

  selectMoveDest: (tileId: string) => {
    const mp = get().movePreview;
    if (!mp || !mp.destPaths.has(tileId)) return;
    set({ movePreview: { ...mp, selectedDest: tileId } });
  },

  confirmMove: () => {
    const mp = get().movePreview;
    if (!mp || mp.selectedDest == null) return;
    const { cardId, selectedDest } = mp;
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.move(MY_ID, cardId, selectedDest));
    } else {
      log.info(`emit game:select_move_card cardId=${cardId} dest=${selectedDest}`);
      getSocket().emit('game:select_move_card', { cardId, destinationTileId: selectedDest });
    }
    set({ selectedCardId: null, movePreview: null });
  },

  cancelMovePreview: () => {
    set({ selectedCardId: null, movePreview: null });
  },

  playCard: (cardId, targetId) => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.play(MY_ID, cardId));
    } else {
      log.info(`emit game:play_card cardId=${cardId} target=${targetId ?? 'none'}`);
      getSocket().emit('game:play_card', { cardId, targetPlayerId: targetId });
    }
    set({ selectedCardId: null, selectedTargetId: null });
  },

  skipPlay: () => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.skip(MY_ID));
    } else {
      log.info('emit game:skip_play');
      getSocket().emit('game:skip_play');
    }
    set({ selectedCardId: null, selectedTargetId: null });
  },

  /** 回答挂起的决策（选对手/选地点/选方向…） */
  choose: (kind, values) => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.choose(MY_ID, values));
      return;
    }
    log.info(`emit game:choose kind=${kind} values=${JSON.stringify(values)}`);
    getSocket().emit('game:choose', { kind, values });
  },

  /** 执行可选动作（站点/建筑的主动行为） */
  doOption: (optionId, targetId) => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.doOption(MY_ID, optionId, targetId));
      return;
    }
    log.info(`emit game:do_option id=${optionId} target=${targetId ?? 'none'}`);
    getSocket().emit('game:do_option', { optionId, targetId });
  },

  /** 结束自己的回合 */
  endTurn: () => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.endTurn());
    } else {
      log.info('emit game:end_turn');
      getSocket().emit('game:end_turn');
    }
    set({ selectedCardId: null, selectedTargetId: null, movePreview: null });
  },

  /** 狱中服刑：抽监狱卡 */
  jailTurn: () => {
    if (get().mode === 'local') {
      withLocal(get, set, (g) => g.jail(MY_ID));
      return;
    }
    log.info('emit game:jail_turn');
    getSocket().emit('game:jail_turn');
  },

  syncGame: () => {
    log.info('emit game:sync');
    getSocket().emit('game:sync');
  },

  sendChat: (text) => {
    if (!text.trim()) return;
    log.debug(`emit chat:send: ${text.slice(0, 30)}`);
    getSocket().emit('chat:send', { text });
  },
}));
