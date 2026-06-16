import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// In dev, proxy /api to the local Fastify server so the SPA and backend share an origin
// (mirrors the Caddy reverse_proxy in production). Override the target with VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
