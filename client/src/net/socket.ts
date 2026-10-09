import { io, type Socket } from 'socket.io-client';
import type { C2SEvents, S2CEvents } from '@gremlins/shared';
import { loggers } from '../utils/logger.js';

// Socket 类型参数：<Listen=服务端发往客户端, Emit=客户端发往服务端>
export type GameSocket = Socket<S2CEvents, C2SEvents>;

let socket: GameSocket | null = null;

export function getSocket(): GameSocket {
  if (socket) return socket;
  const url = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? '/' : window.location.origin);
  loggers.socket.info(`connecting to ${url}`);
  socket = io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionAttempts: 10,
  });
  socket.on('connect', () => {
    loggers.socket.info(`connected id=${socket?.id}`);
  });
  socket.on('disconnect', (reason) => {
    loggers.socket.warn(`disconnected reason=${reason}`);
  });
  socket.on('connect_error', (err) => {
    loggers.socket.error(`connect_error ${err.message}`);
  });
  // socket.io v4: 重连事件需要通过 socket.io.on 监听
  socket.io.on('reconnect_attempt', (attempt) => {
    loggers.socket.info(`reconnect_attempt #${attempt}`);
  });
  socket.io.on('reconnect', (attempt) => {
    loggers.socket.info(`reconnected after #${attempt} attempts`);
  });
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    loggers.socket.info('disconnectSocket()');
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
