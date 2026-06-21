import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { GLOBAL_QUEUE } from '../../src/shared/keys';
import { OperationType, type Task } from '../../src/shared/types';

// 直接對佇列注入同一賬戶的多個批次任務（模擬並發窗口/重複派發），
// 逼出 3 個 AZ worker 對同一賬戶的 OCC 競爭，驗證 Exactly-Once。
// 需先 docker compose up（compose 已對外發布 6379 / 5432）。
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = 'eo-account';

let redis: Redis;
let pool: Pool;

beforeAll(async () => {
  redis = new Redis(REDIS_URL);
  pool = new Pool({ connectionString: DB_URL });
  // 建立/重置專用測試賬戶，使測試確定且可重跑
  await pool.query(
    'INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0) ' +
      'ON CONFLICT (id) DO UPDATE SET balance = 0, version = 0',
    [ACCOUNT],
  );
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('Phase 3 Exactly-Once（多 worker 競爭同一賬戶）', () => {
  it('K 個並發批次跨 AZ → 恰好 K 次提交、餘額正確、無重複/遺漏', async () => {
    const K = 30;
    const AMOUNT = 100;

    // 同時推入 K 個同帳戶批次任務
    const pipe = redis.pipeline();
    for (let i = 0; i < K; i++) {
      const task: Task = {
        taskId: `eo-batch-${i}`,
        accountId: ACCOUNT,
        windowStart: i,
        transactions: [
          { transactionId: `eo-tx-${i}`, operationType: OperationType.Credit, amount: AMOUNT },
        ],
      };
      pipe.lpush(GLOBAL_QUEUE, JSON.stringify(task));
    }
    await pipe.exec();

    // 等帳戶版本推進到 K（或逾時）
    const deadline = Date.now() + 20000;
    let balance = 0;
    let version = 0;
    for (;;) {
      const r = await pool.query<{ balance: string; version: number }>(
        'SELECT balance, version FROM accounts WHERE id = $1',
        [ACCOUNT],
      );
      balance = Number(r.rows[0].balance);
      version = Number(r.rows[0].version);
      if (version >= K || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 100));
    }

    // 恰好 K 次提交（無遺漏、無重複）且餘額正確
    expect(version).toBe(K);
    expect(balance).toBe(K * AMOUNT);
  });
});
