import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api/intent': { target: `http://127.0.0.1:${serverPort}` },
      '/api/music': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
    },
  },
});
