import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The API port. Overriding it (`$env:PORT=4101; npm run dev`) lets the dev
// server run while the installed app holds 4100; the proxy follows it.
const apiPort = Number(process.env.PORT ?? 4100);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5180,
    proxy: {
      // Le proxy évite CORS en dev et garde une seule origine côté navigateur.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
