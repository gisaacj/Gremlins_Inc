import type { Server } from 'socket.io';
import type { C2SEvents, S2CEvents } from '@gremlins/shared';
import type { EngineState } from '@gremlins/shared/engine';
import { AIPlayer, defaultAI } from '@gremlins/shared/engine';
import { loggers } from './utils/logger.js';

type SServer = Server<C2SEvents, S2CEvents>;

/** 只用到 id / players，避免和 rooms.ts 形成循环依赖 */
interface RoomLike {
  id: string;
  players: Map<string, { id: string; name: string; isAI: boolean }>;
}

/** 服务端持有自己的 AI 实例（共享策略，独立步数统计） */
const ai = new AIPlayer();

/**
 * 让 AI 走一步。
 *
 * 策略实现在 `@gremlins/shared/engine`（与客户端单机共用同一套），
 * 这里只负责：确认该玩家确实是 AI → 调策略 → 打日志。
 */
export function runAITurn(io: SServer, room: RoomLike, state: EngineState): void {
  void io;
  const actorId = state.pending ? state.pending.playerId : currentActor(state);
  const lobbyPlayer = room.players.get(actorId);
  if (!lobbyPlayer?.isAI) return;

  const steps = ai.act(state, actorId);
  for (const s of steps) {
    loggers.ai.debug(`AI ${lobbyPlayer.name} ${s.action}${s.detail ? ` ${s.detail}` : ''}`);
  }
  if (!steps.length) loggers.ai.warn(`AI ${lobbyPlayer.name} 无动作`);
}

function currentActor(state: EngineState): string {
  return state.players[state.currentIndex]?.id ?? '';
}

export { ai, defaultAI };
