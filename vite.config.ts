import { defineConfig } from 'vite';

// A plain object (no casts) so Cloudflare's deploy tooling can read it. Test settings: vitest.config.ts.
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
  server: { port: 5173 },
});
