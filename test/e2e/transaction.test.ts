import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OperationType } from '../../src/shared/types';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const ACCOUNT = 'hot-account-1';

interface TxnResponse {
  accountId: string;
  balance: number;
  version: number;
}

async function postTxn(accountId: string, op: OperationType, amount: number): Promise<Response> {
  return fetch(`${BASE_URL}/accounts/${accountId}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactionId: randomUUID(), operationType: op, amount }),
  });
}

describe('Phase 1 端到端：單筆交易', () => {
  // 以 delta 斷言，與賬戶起始狀態/重複執行無關。
  it('Credit 後餘額增加、版本 +1', async () => {
    const r1 = await postTxn(ACCOUNT, OperationType.Credit, 1000);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as TxnResponse;

    const r2 = await postTxn(ACCOUNT, OperationType.Credit, 500);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as TxnResponse;

    expect(b2.balance).toBe(b1.balance + 500);
    expect(b2.version).toBe(b1.version + 1);
  });

  it('Debit 後餘額減少、版本 +1', async () => {
    const r1 = await postTxn(ACCOUNT, OperationType.Credit, 1000);
    const b1 = (await r1.json()) as TxnResponse;

    const r2 = await postTxn(ACCOUNT, OperationType.Debit, 300);
    const b2 = (await r2.json()) as TxnResponse;

    expect(b2.balance).toBe(b1.balance - 300);
    expect(b2.version).toBe(b1.version + 1);
  });

  it('相同 transactionId 重送具基本冪等（不重複記帳）', async () => {
    const txId = randomUUID();
    const make = (): Promise<Response> =>
      fetch(`${BASE_URL}/accounts/${ACCOUNT}/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transactionId: txId,
          operationType: OperationType.Credit,
          amount: 100,
        }),
      });

    const b1 = (await (await make()).json()) as TxnResponse;
    const b2 = (await (await make()).json()) as TxnResponse;

    // 第二次應回快取結果：餘額與版本皆不變（未被二次套用）
    expect(b2.balance).toBe(b1.balance);
    expect(b2.version).toBe(b1.version);
  });

  it('未知賬戶回 404', async () => {
    const res = await postTxn('does-not-exist', OperationType.Credit, 1);
    expect(res.status).toBe(404);
  });

  it('非法輸入回 400', async () => {
    const res = await fetch(`${BASE_URL}/accounts/${ACCOUNT}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId: '', operationType: OperationType.Credit, amount: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
