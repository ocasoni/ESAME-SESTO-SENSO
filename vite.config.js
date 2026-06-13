import { defineConfig } from 'vite';
import { resolve } from 'path';

const base = process.env.VITE_BASE_PATH || '/';

export default defineConfig({
  base,
  server: {
    host: true,
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mic: resolve(__dirname, 'mic/index.html'),
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
});
