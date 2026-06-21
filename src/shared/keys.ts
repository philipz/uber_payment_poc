// Redis key 命名，供 batch-creator 與 batch-process 共用以保持一致。

// 全域任務佇列（Phase 2 起：一個 batch 一個任務）
export const GLOBAL_QUEUE = 'tasks:global';

// 時間窗口長度（毫秒）
export const WINDOW_MS = 250;

// 結果快取：worker 寫入、creator 輪詢
export const resultKey = (taskId: string): string => `result:${taskId}`;
