// Redis key 命名，供 batch-creator 與 batch-process 共用以保持一致。

// 全域任務佇列（Phase 1：每筆交易一個任務；Phase 2 起改為一個 batch 一個任務）
export const GLOBAL_QUEUE = 'tasks:global';

// 結果快取：worker 寫入、creator 輪詢
export const resultKey = (taskId: string): string => `result:${taskId}`;
