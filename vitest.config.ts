import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // E2E 會拉起 stack 並含 250ms 計時，給寬一點的逾時
    testTimeout: 30000,
    hookTimeout: 30000,
    // E2E 測試共用單一 compose stack（batch-creator/Redis/Postgres）；序列執行避免
    // 重負載測試（load-generator）與其他測試並行時互相爭用造成連線重置（ECONNRESET）。
    fileParallelism: false,
  },
});
