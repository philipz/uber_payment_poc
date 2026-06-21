// Redis key 命名，供 batch-creator 與 batch-process 共用以保持一致。

// 全域任務佇列（Phase 2 起：一個 batch 一個任務）
export const GLOBAL_QUEUE = 'tasks:global';

// 時間窗口長度（毫秒）
export const WINDOW_MS = 250;

// 後處理審計佇列：worker 提交後推入、post-process 非同步消費落庫
export const AUDIT_QUEUE = 'audit:queue';

// 領域事件廣播頻道（Redis pub/sub）：各服務發布狀態機事件，creator 訂閱後轉發給 SSE 客戶端
export const EVENTS_CHANNEL = 'events';

// 對照組計量：每模式的請求數與 DB 寫入數，用於壓縮比展示
export const requestsKey = (mode: string): string => `metrics:requests:${mode}`;
export const dbWritesKey = (mode: string): string => `metrics:dbwrites:${mode}`;

// 結果快取：worker 寫入、creator 輪詢
export const resultKey = (taskId: string): string => `result:${taskId}`;
