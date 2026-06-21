import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OperationType } from '../../src/shared/types';

// 驗證 issue #15：同一 transactionId 即使並發重送或跨批次重放，也只套用一次（修正情況 B）。
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = `idem-account-${Math.random().toString(36).substring(2, 9)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 1000, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

function postSame(txId: string): Promise<Response> {
  return fetch(`${BASE_URL}/accounts/${ACCOUNT}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactionId: txId, operationType: OperationType.Credit, amount: 100 }),
  });
}

describe('Phase fix #15：交易級冪等', () => {
  it('同一 transactionId 並發 + 跨批次重放只套用一次', async () => {
    const txId = 'idem-fixed-txid';

    // 同窗口並發 5 筆相同 txid
    const wave1 = await Promise.all(Array.from({ length: 5 }, () => postSame(txId)));
    for (const r of wave1) expect(r.status).toBe(200);

    // 等窗口關閉後，於新窗口再送同 txid（測跨批次的 DB 去重）
    await sleep(400);
    const again = await postSame(txId);
    expect(again.status).toBe(200);
    await sleep(400);

    // 餘額只 +100（1000 → 1100），非重複記帳
    const acc = await pool.query<{ balance: string }>(
      'SELECT balance FROM accounts WHERE id = $1',
      [ACCOUNT],
    );
    expect(Number(acc.rows[0].balance)).toBe(1100);

    // 冪等標記與審計各只有一筆
    const processed = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM processed_transactions WHERE transaction_id = $1',
      [txId],
    );
    expect(Number(processed.rows[0].n)).toBe(1);

    const audit = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM audit WHERE account_id = $1',
      [ACCOUNT],
    );
    expect(Number(audit.rows[0].n)).toBe(1);
  });
});
