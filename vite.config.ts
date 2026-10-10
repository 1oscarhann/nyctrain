import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
} as never);
