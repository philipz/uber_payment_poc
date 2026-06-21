import { OperationType, type TransactionInput } from './types';

// 純函式：對餘額套用單筆操作，回傳新餘額（最小貨幣單位）。
// PoC 簡化：Authorize 視為保留扣減、Release 視為回補；不單獨建模授權額度。
export function applyOperation(balance: number, op: OperationType, amount: number): number {
  switch (op) {
    case OperationType.Credit:
      return balance + amount;
    case OperationType.Debit:
      return balance - amount;
    case OperationType.Authorize:
      return balance - amount;
    case OperationType.Release:
      return balance + amount;
    default:
      throw new Error(`unknown operation type: ${op}`);
  }
}

export interface ReplayStep {
  transactionId: string;
  balanceAfter: number;
}

// 純函式：對一個 batch 內的交易依序重放，回傳最終餘額與每筆交易後的餘額。
export function replayBatch(
  balance: number,
  transactions: TransactionInput[],
): { newBalance: number; steps: ReplayStep[] } {
  let running = balance;
  const steps: ReplayStep[] = [];
  for (const t of transactions) {
    running = applyOperation(running, t.operationType, t.amount);
    steps.push({ transactionId: t.transactionId, balanceAfter: running });
  }
  return { newBalance: running, steps };
}
