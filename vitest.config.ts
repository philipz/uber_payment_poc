import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // E2E 會拉起 stack 並含 250ms 計時，給寬一點的逾時
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
