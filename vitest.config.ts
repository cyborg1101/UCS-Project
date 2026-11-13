import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const alias = {
  '@ucs/shared': resolve(__dirname, 'libs/shared/src/index.ts'),
  '@ucs/kernel': resolve(__dirname, 'libs/kernel/src/index.ts'),
  '@ucs/platform-audit': resolve(__dirname, 'libs/platform/audit/src/index.ts'),
  '@ucs/platform-messaging': resolve(__dirname, 'libs/platform/messaging/src/index.ts'),
  '@ucs/platform-files': resolve(__dirname, 'libs/platform/files/src/index.ts'),
  '@ucs/module-sample': resolve(__dirname, 'libs/modules/sample/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    globals: false,
    include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts', 'tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
