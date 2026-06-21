import { describe, expect, it } from 'vitest';
import { applyOperation, dedupeTransactions, replayBatch } from '../../src/shared/operations';
import { OperationType, type TransactionInput } from '../../src/shared/types';

const tx = (id: string): TransactionInput => ({
  transactionId: id,
  operationType: OperationType.Credit,
  amount: 1,
});

describe('applyOperation', () => {
  it('Credit 增加餘額', () => {
    expect(applyOperation(100, OperationType.Credit, 50)).toBe(150);
  });

  it('Debit 減少餘額', () => {
    expect(applyOperation(100, OperationType.Debit, 30)).toBe(70);
  });

  it('Authorize 視為保留扣減', () => {
    expect(applyOperation(100, OperationType.Authorize, 40)).toBe(60);
  });

  it('Release 視為回補', () => {
    expect(applyOperation(100, OperationType.Release, 40)).toBe(140);
  });

  it('未知操作丟出例外', () => {
    expect(() => applyOperation(100, 0x99 as OperationType, 1)).toThrow();
  });
});

describe('replayBatch', () => {
  it('依序重放並回傳每筆後餘額與最終餘額', () => {
    const txns: TransactionInput[] = [
      { transactionId: 'a', operationType: OperationType.Credit, amount: 100 },
      { transactionId: 'b', operationType: OperationType.Debit, amount: 30 },
      { transactionId: 'c', operationType: OperationType.Credit, amount: 5 },
    ];
    const { newBalance, steps } = replayBatch(1000, txns);
    expect(newBalance).toBe(1075);
    expect(steps).toEqual([
      { transactionId: 'a', balanceAfter: 1100 },
      { transactionId: 'b', balanceAfter: 1070 },
      { transactionId: 'c', balanceAfter: 1075 },
    ]);
  });

  it('空批次回原餘額', () => {
    expect(replayBatch(500, [])).toEqual({ newBalance: 500, steps: [] });
  });
});

describe('dedupeTransactions', () => {
  it('排除批次內重複的 transactionId（保留首次）', () => {
    const out = dedupeTransactions([tx('a'), tx('b'), tx('a')], new Set());
    expect(out.map((t) => t.transactionId)).toEqual(['a', 'b']);
  });

  it('排除已套用的 transactionId', () => {
    const out = dedupeTransactions([tx('a'), tx('b')], new Set(['a']));
    expect(out.map((t) => t.transactionId)).toEqual(['b']);
  });

  it('全部重複時回空陣列', () => {
    expect(dedupeTransactions([tx('a'), tx('a')], new Set(['a']))).toEqual([]);
  });
});
