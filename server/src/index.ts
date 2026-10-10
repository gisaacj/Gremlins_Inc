import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import type { C2SEvents, S2CEvents } from '@gremlins/shared';
import { attachHandlers } from './rooms.js';
import { loggers } from './utils/logger.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');

const app = express();
app.use(cors());
app.use(express.json());

// API 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// 生产模式：托管前端静态文件
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA 路由回退：非 /api、非 /socket.io 的路由都返回 index.html
  app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  loggers.server.info(`serving client from ${clientDist}`);
} else {
  loggers.server.warn(`client/dist not found at ${clientDist}, running in API-only mode`);
}

const server = http.createServer(app);
const io = new Server<C2SEvents, S2CEvents>(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  loggers.net.info(`client connected id=${socket.id} transport=${socket.conn.transport.name}`);
  socket.on('disconnect', (reason) => {
    loggers.net.info(`client disconnected id=${socket.id} reason=${reason}`);
  });
  attachHandlers(io, socket);
});

server.listen(PORT, HOST, () => {
  loggers.server.info(`Server listening on http://${HOST}:${PORT}`);
});

// 未捕获异常兜底
process.on('uncaughtException', (err) => {
  loggers.server.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  loggers.server.error('unhandledRejection:', reason);
});
