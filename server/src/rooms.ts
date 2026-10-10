import type { Server, Socket } from 'socket.io';
import type {
  RoomConfig, LobbyState, LobbyPlayer, PlayerPrompt,
  C2SEvents, S2CEvents,
} from '@gremlins/shared';
import { DEFAULT_ROOM_CONFIG, CHARACTERS } from '@gremlins/shared';
import type { EngineState } from '@gremlins/shared/engine';
import {
  answerChoice, buildEnginePrompt, currentPlayerId, hasPending, isTurn,
  jailTurn, moveWithCard, newGame, nextTurn, playCard, playChaosCard, runOption, serializeEngineState, skipPlay,
} from '@gremlins/shared/engine';
import { runAITurn } from './ai.js';
import { loggers } from './utils/logger.js';

/**
 * 房间管理器：每个房间持有一个权威的 EngineState（开局后）与 LobbyState（开局前）。
 *
 * 引擎来自 `@gremlins/shared/engine`（与客户端单机模式共用同一份代码）。
 */
interface Room {
  id: string;
  hostId: string;
  config: RoomConfig;
  players: Map<string, LobbyPlayer>;  // socketId -> player
  socketToName: Map<string, string>;
  gameState?: EngineState;
  phase: 'lobby' | 'character_select' | 'playing';
  /** AI 玩家计数 */
  aiCounter: number;
}

class RoomRegistry {
  private rooms = new Map<string, Room>();
  private socketToRoom = new Map<string, string>();

  createRoom(hostSocketId: string, name: string, config?: Partial<RoomConfig>): Room {
    const id = generateRoomId();
    const room: Room = {
      id,
      hostId: hostSocketId,
      config: { ...DEFAULT_ROOM_CONFIG, ...config },
      players: new Map(),
      socketToName: new Map(),
      phase: 'lobby',
      aiCounter: 0,
    };
    this.addPlayerToRoom(room, hostSocketId, name);
    this.rooms.set(id, room);
    this.socketToRoom.set(hostSocketId, id);
    return room;
  }

  joinRoom(roomId: string, socketId: string, name: string): { ok: boolean; error?: string; room?: Room } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.phase !== 'lobby' && room.phase !== 'character_select') {
      const existing = Array.from(room.players.values()).find((p) => p.name === name && !p.connected);
      if (existing) {
        const oldId = existing.id;
        existing.id = socketId;
        existing.connected = true;
        this.socketToRoom.set(socketId, roomId);
        // 同步引擎里的玩家 id（重连换了 socket）
        if (room.gameState) {
          const ep = room.gameState.players.find((x) => x.id === oldId);
          if (ep) ep.id = socketId;
        }
        room.players.delete(oldId);
        room.players.set(socketId, existing);
        return { ok: true, room };
      }
      return { ok: false, error: '游戏已开始，且无可重连的玩家' };
    }
    if (room.players.size >= room.config.maxPlayers) {
      return { ok: false, error: '房间已满' };
    }
    this.addPlayerToRoom(room, socketId, name);
    this.socketToRoom.set(socketId, roomId);
    return { ok: true, room };
  }

  private addPlayerToRoom(room: Room, socketId: string, name: string): void {
    const player: LobbyPlayer = {
      id: socketId,
      name,
      ready: false,
      connected: true,
      isAI: false,
    };
    room.players.set(socketId, player);
    room.socketToName.set(socketId, name);
  }

  leaveRoom(socketId: string): Room | undefined {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return undefined;
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const player = room.players.get(socketId);
    if (player) {
      if (player.isAI) {
        room.players.delete(socketId);
      } else if (room.phase === 'lobby' || room.phase === 'character_select') {
        room.players.delete(socketId);
        if (room.hostId === socketId) {
          const nextHost = Array.from(room.players.values()).find((p) => !p.isAI);
          if (nextHost) room.hostId = nextHost.id;
          else {
            this.rooms.delete(roomId);
            this.socketToRoom.delete(socketId);
            return room;
          }
        }
      } else {
        player.connected = false;
        if (room.gameState) {
          const ep = room.gameState.players.find((x) => x.id === socketId);
          if (ep) ep.connected = false;
        }
      }
    }
    this.socketToRoom.delete(socketId);
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getRoomBySocket(socketId: string): Room | undefined {
    const roomId = this.socketToRoom.get(socketId);
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  addAI(roomId: string): { ok: boolean; error?: string; aiId?: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.players.size >= room.config.maxPlayers) return { ok: false, error: '房间已满' };
    const aiId = `ai_${room.id}_${++room.aiCounter}`;
    const aiPlayer: LobbyPlayer = {
      id: aiId,
      name: `AI ${room.aiCounter}`,
      ready: true,
      connected: true,
      isAI: true,
    };
    room.players.set(aiId, aiPlayer);
    return { ok: true, aiId };
  }

  toLobbyState(room: Room): LobbyState {
    return {
      roomId: room.id,
      hostId: room.hostId,
      config: room.config,
      players: Array.from(room.players.values()),
      phase: room.phase === 'playing' ? 'character_select' : room.phase,
    };
  }
}

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

export const registry = new RoomRegistry();

// =============================================================
// 事件处理
// =============================================================

type SSocket = Socket<C2SEvents, S2CEvents>;
type SServer = Server<C2SEvents, S2CEvents>;

export function attachHandlers(io: SServer, socket: SSocket): void {
  const log = loggers.net.child(socket.id.slice(0, 8));

  // ---- 房间 ----
  socket.on('room:create', async (payload, ack) => {
    log.info('room:create name=', payload.name);
    const room = registry.createRoom(socket.id, payload.name, payload.config);
    await socket.join(room.id);
    ack({ ok: true, roomId: room.id });
    broadcastLobby(io, room);
  });

  socket.on('room:join', async (payload, ack) => {
    log.info('room:join roomId=', payload.roomId, 'name=', payload.name);
    const res = registry.joinRoom(payload.roomId, socket.id, payload.name);
    if (!res.ok || !res.room) {
      log.warn('room:join FAIL:', res.error);
      ack({ ok: false, error: res.error });
      return;
    }
    await socket.join(res.room.id);
    ack({ ok: true });
    broadcastLobby(io, res.room);
    if (res.room.gameState && res.room.phase === 'playing') {
      log.info('reconnect: sending game state');
      sendGameState(io, res.room, socket.id);
      emitPromptTo(io, res.room, socket.id);
    }
  });

  socket.on('room:leave', async () => {
    const room = registry.leaveRoom(socket.id);
    if (room) {
      await socket.leave(room.id);
      broadcastLobby(io, room);
    }
  });

  socket.on('room:ready', (payload) => {
    const room = registry.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = payload.ready;
    broadcastLobby(io, room);
  });

  socket.on('room:select_character', (payload) => {
    log.info('room:select_character charId=', payload.characterId);
    const room = registry.getRoomBySocket(socket.id);
    if (!room || room.phase !== 'character_select') return;
    const taken = Array.from(room.players.values())
      .some((p) => p.characterId === payload.characterId && p.id !== socket.id);
    if (taken) {
      socket.emit('error', { code: 'CHAR_TAKEN', message: '该角色已被选' });
      return;
    }
    const player = room.players.get(socket.id);
    if (!player) return;
    if (room.config.charSelectMode === 'pick3' && player.charOptions
      && !player.charOptions.includes(payload.characterId)) {
      socket.emit('error', { code: 'CHAR_NOT_IN_OPTIONS', message: '该角色不在你的选项中' });
      return;
    }
    player.characterId = payload.characterId;
    broadcastLobby(io, room);
  });

  socket.on('room:add_ai', () => {
    const room = registry.getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby') return;
    registry.addAI(room.id);
    broadcastLobby(io, room);
  });

  socket.on('room:update_config', (payload) => {
    const room = registry.getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby') return;
    room.config = { ...room.config, ...payload };
    broadcastLobby(io, room);
  });

  socket.on('room:start', () => {
    log.info('room:start');
    const room = registry.getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;

    if (room.phase === 'lobby') {
      const othersReady = Array.from(room.players.values())
        .every((p) => p.id === socket.id || p.isAI || p.ready);
      if (!othersReady) {
        socket.emit('error', { code: 'NOT_READY', message: '还有玩家未准备' });
        return;
      }
      if (room.players.size < 2) {
        socket.emit('error', { code: 'NEED_MORE', message: '至少需要 2 名玩家' });
        return;
      }
      if (room.config.charSelectMode === 'random') {
        const allChars = [...CHARACTERS].sort(() => Math.random() - 0.5);
        let ci = 0;
        for (const p of room.players.values()) {
          if (ci < allChars.length) p.characterId = allChars[ci++].id;
        }
        room.phase = 'character_select';
        broadcastLobby(io, room);
        startGame(io, room);
        return;
      }
      // 三选一：每人发 3 个不重复的角色
      const allChars = [...CHARACTERS].sort(() => Math.random() - 0.5);
      const players = Array.from(room.players.values());
      let ci = 0;
      for (const p of players) {
        p.charOptions = allChars.slice(ci, ci + 3).map((c) => c.id);
        ci += 3;
      }
      room.phase = 'character_select';
      broadcastLobby(io, room);
      return;
    }

    if (room.phase === 'character_select') {
      const players = Array.from(room.players.values());
      const needChar = players.filter((p) => !p.isAI && !p.characterId);

      for (const p of players) {
        if (p.isAI && !p.characterId) {
          const taken = new Set(players.map((pp) => pp.characterId).filter(Boolean));
          const pool = p.charOptions?.filter((id) => !taken.has(id)) ?? [];
          const allAvail = [...pool, ...CHARACTERS.filter((c) => !taken.has(c.id)).map((c) => c.id)];
          if (allAvail.length > 0) {
            p.characterId = allAvail[0];
            loggers.ai.info(`AI ${p.name} auto-pick ${p.characterId}`);
          }
        }
      }
      for (const p of needChar) {
        const taken = new Set(players.map((pp) => pp.characterId).filter(Boolean));
        const pool = p.charOptions?.filter((id) => !taken.has(id)) ?? [];
        const available = pool[0] ?? CHARACTERS.find((c) => !taken.has(c.id))?.id;
        if (available) p.characterId = available;
      }
      startGame(io, room);
    }
  });

  // ---- 游戏内 ----
  socket.on('game:sync', () => {
    const room = registry.getRoomBySocket(socket.id);
    if (room?.gameState && room.phase === 'playing') {
      sendGameState(io, room, socket.id);
      emitPromptTo(io, room, socket.id);
    }
  });

  /** 统一的动作处理：跑引擎 → 广播 → 推 AI */
  const runAction = (
    label: string,
    fn: (room: Room, state: EngineState) => { ok: boolean; error?: string },
  ) => {
    const room = registry.getRoomBySocket(socket.id);
    if (!room?.gameState) return;
    if (room.phase !== 'playing') return;
    const res = fn(room, room.gameState);
    if (!res.ok) {
      log.warn(`${label} FAIL:`, res.error);
      socket.emit('error', { code: 'INVALID_ACTION', message: res.error ?? '无效操作' });
      return;
    }
    log.info(`${label} ok`);
    afterAction(io, room);
  };

  socket.on('game:select_move_card', (payload) => {
    log.info('game:select_move_card cardId=', payload.cardId, 'dest=', payload.destinationTileId, 'customSteps=', payload.customSteps);
    runAction('select_move_card', (_room, state) => {
      // 掷骰移动牌（a022 装腔作势）：客户端先掷骰，把结果作为 customSteps 发来。
      // 之前服务端忽略此字段，导致 move=0 的特殊移动牌在联机模式走 0 步。
      if (payload.customSteps != null) {
        const p = state.players.find((x) => x.id === socket.id);
        if (p) p.flags['customMoveSteps'] = payload.customSteps;
      }
      return moveWithCard(state, socket.id, payload.cardId, payload.destinationTileId);
    });
  });

  socket.on('game:play_card', (payload) => {
    log.info('game:play_card cardId=', payload.cardId);
    runAction('play_card', (_room, state) => playCard(state, socket.id, payload.cardId));
  });

  socket.on('game:choose', (payload) => {
    log.info('game:choose kind=', payload.kind, 'values=', payload.values);
    runAction('choose', (_room, state) => answerChoice(state, socket.id, payload.values));
  });

  socket.on('game:skip_play', () => {
    runAction('skip_play', (_room, state) => skipPlay(state, socket.id));
  });

  /** 执行可选动作（投资、卖选票、打工、赌博…） */
  socket.on('game:do_option', (payload) => {
    log.info('game:do_option id=', payload.optionId, 'target=', payload.targetId);
    runAction('do_option', (_room, state) =>
      runOption(state, socket.id, payload.optionId, payload.targetId));
  });

  /** 打出混沌卡（暴乱卡，全员共享池） */
  socket.on('game:play_chaos', (payload) => {
    log.info('game:play_chaos id=', payload.cardId, 'permanent=', payload.permanentId);
    runAction('play_chaos', (_room, state) =>
      playChaosCard(state, socket.id, payload.cardId, { permanentId: payload.permanentId }));
  });

  /** 结束自己的回合（由玩家显式推进回合） */
  socket.on('game:end_turn', () => {
    log.info('game:end_turn');
    runAction('end_turn', (_room, state) => {
      if (!isTurn(state, socket.id)) return { ok: false, error: '不是你的回合' };
      const r = nextTurn(state);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  });

  /** 狱中服刑：抽监狱卡结算 */
  socket.on('game:jail_turn', () => {
    log.info('game:jail_turn');
    runAction('jail_turn', (_room, state) => {
      const r = jailTurn(state, socket.id);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    });
  });

  socket.on('chat:send', (payload) => {
    const room = registry.getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(room.id).emit('chat:recv', {
      playerId: socket.id,
      name: player.name,
      text: payload.text.slice(0, 200),
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    log.info('disconnect');
    const room = registry.leaveRoom(socket.id);
    if (room) {
      broadcastLobby(io, room);
      if (room.gameState && room.phase === 'playing') {
        broadcastGameState(io, room);
        maybeRunAI(io, room);
      }
    }
  });
}

// =============================================================
// 工具函数
// =============================================================

function broadcastLobby(io: SServer, room: Room): void {
  const state = registry.toLobbyState(room);
  io.to(room.id).emit('room:state', state);
  if (room.phase === 'character_select') {
    io.to(room.id).emit('room:character_select', state);
  }
}

function startGame(io: SServer, room: Room): void {
  const players = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    isAI: p.isAI,
    characterId: p.characterId,
  }));
  loggers.room.info(`startGame roomId=${room.id} players=${players.length}`);

  const state = newGame({
    roomId: room.id,
    players,
    targetScore: room.config.targetCogs,
    chaosEnabled: room.config.enableRiotCards,
  });
  room.gameState = state;
  room.phase = 'playing';

  io.to(room.id).emit('game:start');
  loggers.engine.info(
    `game started firstPlayer=${currentPlayerId(state)} round=${state.round} map=${state.mapId}`,
  );
  broadcastGameState(io, room);
  broadcastAllPrompts(io, room);
  maybeRunAI(io, room);
}

/** 一次动作之后：广播状态、刷新提示、推进 AI */
function afterAction(io: SServer, room: Room): void {
  broadcastGameState(io, room);
  broadcastAllPrompts(io, room);
  maybeRunAI(io, room);
}

/** 每个真人玩家都收到"属于自己的"提示 */
function broadcastAllPrompts(io: SServer, room: Room): void {
  if (!room.gameState) return;
  for (const pid of room.players.keys()) emitPromptTo(io, room, pid);
}

function emitPromptTo(io: SServer, room: Room, viewerId: string): void {
  if (!room.gameState) return;
  const player = room.players.get(viewerId);
  if (!player || player.isAI) return;
  const prompt = buildEnginePrompt(room.gameState, viewerId);
  if (prompt) io.to(viewerId).emit('game:prompt', prompt);
}

function broadcastGameState(io: SServer, room: Room): void {
  if (!room.gameState) return;
  loggers.engine.debug(
    `broadcast round=${room.gameState.round} pending=${room.gameState.pending?.kind ?? '-'} `
    + `cur=${currentPlayerId(room.gameState)}`,
  );
  for (const pid of room.players.keys()) sendGameState(io, room, pid);
  if (room.gameState.phase === 'game_over' && room.gameState.winnerId) {
    loggers.engine.info(`GAME OVER winner=${room.gameState.winnerId}`);
    io.to(room.id).emit('game:over', room.gameState.winnerId);
  }
}

function sendGameState(io: SServer, room: Room, viewerId: string): void {
  if (!room.gameState) return;
  const player = room.players.get(viewerId);
  if (!player || player.isAI) return;
  io.to(viewerId).emit('game:state', serializeEngineState(room.gameState, viewerId));
}

/** 若当前行动者是 AI（或有待 AI 决策），跑一步 AI */
function maybeRunAI(io: SServer, room: Room): void {
  if (!room.gameState) return;
  const state = room.gameState;
  if (state.phase !== 'playing') return;

  // 待决策由发起者回答；发起者可能是 AI
  const actorId = state.pending ? state.pending.playerId : currentPlayerId(state);
  const player = room.players.get(actorId);
  if (!player || !player.isAI) return;

  loggers.ai.info(`AI ${player.name} thinking... round=${state.round} pending=${state.pending?.kind ?? '-'}`);
  io.to(room.id).emit('game:ai_thinking', actorId);

  setTimeout(() => {
    // 状态可能在这 800ms 内变化（例如人类玩家操作或换人）
    if (!room.gameState || room.gameState.phase !== 'playing') return;
    const stillActor = room.gameState.pending
      ? room.gameState.pending.playerId === actorId
      : currentPlayerId(room.gameState) === actorId;
    if (!stillActor) {
      loggers.ai.debug('AI canceled (state changed)');
      return;
    }
    try {
      runAITurn(io, room as never, room.gameState as never);
    } catch (e) {
      loggers.ai.error(`AI 出错: ${(e as Error).message}`);
    }
    broadcastGameState(io, room);
    broadcastAllPrompts(io, room);
    maybeRunAI(io, room);
  }, 500);
}

export type { Room };
