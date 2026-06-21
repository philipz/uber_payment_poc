import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { resultKey } from '../../src/shared/keys';
import { OperationType } from '../../src/shared/types';

// 驗證 issue #15：同一 transactionId 即使並發重送或跨批次重放，也只套用一次（修正情況 B）。
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
const ACCOUNT = `idem-account-${Math.random().toString(36).substring(2, 9)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: Pool;
let redis: Redis;

interface TxnResponse {
  balance: number;
  version: number;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  redis = new Redis(REDIS_URL);
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 1000, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (redis) await redis.quit();
});

function post(account: string, txId: string, amount: number): Promise<Response> {
  return fetch(`${BASE_URL}/accounts/${account}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactionId: txId, operationType: OperationType.Credit, amount }),
  });
}

const postSame = (txId: string): Promise<Response> => post(ACCOUNT, txId, 100);

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

  it('快取失效後重試回傳「歷史餘額」而非當前值（嚴格冪等）', async () => {
    const acc = `idem-strict-${Math.random().toString(36).substring(2, 9)}`;
    await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 1000, 0)', [acc]);
    const txA = 'strict-A';

    // 首次套用 txA：餘額 1000 → 1100
    const first = (await (await post(acc, txA, 100)).json()) as TxnResponse;
    await sleep(400);
    expect(first.balance).toBe(1100);

    // 模擬 txA 結果快取過期，並用另一筆不同交易把帳戶推進到 1600
    await redis.del(resultKey(txA));
    await post(acc, 'strict-B', 500);
    await sleep(400);

    // 重試 txA（快取已失效 → 進到 worker，由 processed_transactions 命中）
    const retry = (await (await post(acc, txA, 100)).json()) as TxnResponse;
    await sleep(200);

    // 嚴格冪等：回當時歷史餘額 1100、原版本，而非當前 1600
    expect(retry.balance).toBe(1100);
    expect(retry.version).toBe(first.version);

    // 帳戶實際餘額維持 1600（txA 重試未二次套用）
    const acct = await pool.query<{ balance: string }>('SELECT balance FROM accounts WHERE id=$1', [
      acc,
    ]);
    expect(Number(acct.rows[0].balance)).toBe(1600);
  });
});
