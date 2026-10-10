import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@gremlins/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
      // JSON 数据文件：客户端从 client/src/data 加载（避免中文路径问题）
      '../data/action_card.json': fileURLToPath(new URL('./src/data/action_card.json', import.meta.url)),
      '../data/riot_card.json': fileURLToPath(new URL('./src/data/riot_card.json', import.meta.url)),
      '../data/jail_card.json': fileURLToPath(new URL('./src/data/jail_card.json', import.meta.url)),
      '../data/misfortune.json': fileURLToPath(new URL('./src/data/misfortune.json', import.meta.url)),
      '../data/building.json': fileURLToPath(new URL('./src/data/building.json', import.meta.url)),
      '../data/station.json': fileURLToPath(new URL('./src/data/station.json', import.meta.url)),
      '../data/character.json': fileURLToPath(new URL('./src/data/character.json', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
