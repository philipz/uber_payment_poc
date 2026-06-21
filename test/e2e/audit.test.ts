import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { MICRO_UAC_SIZE, unpackMicroUAC } from '../../src/shared/microuac';
import { OperationType } from '../../src/shared/types';

// 需先 docker compose up（compose 已對外發布 3000 / 5432）。
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = `audit-account-${Math.random().toString(36).substring(2, 9)}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('Phase 4 後處理審計：MicroUAC 落庫', () => {
  it('一筆交易產生 48-byte MicroUAC，可解碼回欄位', async () => {
    const AMOUNT = 777;
    const res = await fetch(`${BASE_URL}/accounts/${ACCOUNT}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: randomUUID(),
        operationType: OperationType.Credit,
        amount: AMOUNT,
      }),
    });
    expect(res.status).toBe(200);

    // 後處理為非同步：輪詢審計表直到出現該帳戶的記錄
    const deadline = Date.now() + 10000;
    let row: { micro_uac: Buffer; status: string } | undefined;
    for (;;) {
      const r = await pool.query<{ micro_uac: Buffer; status: string }>(
        'SELECT micro_uac, status FROM audit WHERE account_id = $1 LIMIT 1',
        [ACCOUNT],
      );
      row = r.rows[0];
      if (row || Date.now() > deadline) break;
      await new Promise((res2) => setTimeout(res2, 100));
    }

    expect(row).toBeDefined();
    expect(row!.status).toBe('Committed');
    expect(row!.micro_uac.length).toBe(MICRO_UAC_SIZE);

    const decoded = unpackMicroUAC(row!.micro_uac);
    expect(decoded.operationType).toBe(OperationType.Credit);
    expect(decoded.amount).toBe(BigInt(AMOUNT));
    expect(decoded.accountVersion).toBe(1); // 全新帳戶首次提交
  });
});
