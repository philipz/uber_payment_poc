// PoC 共用領域型別。詞彙定義見 CONTEXT.md。

// MicroUAC 的 OperationType 代碼
export enum OperationType {
  Credit = 0x01, // 貸記
  Debit = 0x02, // 借記
  Authorize = 0x03, // 授權
  Release = 0x04, // 釋放
}

// 客戶端送進來的單筆變更請求
export interface TransactionRequest {
  transactionId: string;
  accountId: string;
  operationType: OperationType;
  amount: number; // 最小貨幣單位（分）
  referenceId: string; // 業務單據（如訂單 ID），用於冪等
  businessTime: number; // Unix 秒
}

// 一個 Batch：同一賬戶、同一 250ms 窗口內的請求集合
export interface Batch {
  batchId: string;
  accountId: string;
  windowStart: number; // 由 Redis TIME 裁定的窗口起點（ms）
  transactions: TransactionRequest[];
}

// 主資料庫中的賬戶狀態
export interface AccountState {
  id: string;
  balance: number;
  version: number;
}

// 客戶端 POST body（單筆交易輸入）
export interface TransactionInput {
  transactionId: string;
  operationType: OperationType;
  amount: number; // 最小貨幣單位（分），須為正整數
  referenceId?: string;
  businessTime?: number;
}

// 推入全域佇列的任務（Phase 2 起：一個 batch = 同帳戶同窗口的多筆交易）
export interface Task {
  taskId: string;
  accountId: string;
  windowStart: number;
  transactions: TransactionInput[];
}

// worker 寫入結果快取、creator 輪詢回傳
export interface TaskResult {
  taskId: string;
  accountId: string;
  status: 'ok' | 'error';
  balance?: number;
  version?: number;
  error?: 'account not found' | 'conflict' | 'internal';
  az?: string;
}

// 交易/批次的狀態機（見 CONTEXT.md 與 spec）
export enum TxnState {
  Ingested = 'Ingested',
  Accumulating = 'Accumulating',
  Queued = 'Queued',
  Processing = 'Processing',
  TentativeLogged = 'TentativeLogged',
  Committed = 'Committed',
  Finalized = 'Finalized',
}
