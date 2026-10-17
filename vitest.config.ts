import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts', 'tests/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
  },
});
