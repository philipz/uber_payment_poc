import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { WORKERS_SET, aliveKey, processingKey } from '../../src/shared/keys';
import { OperationType, type Task } from '../../src/shared/types';

// 驗證 issue #17：worker 崩潰時其在途任務不丟失，由其他 worker 重認領完成。
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';
const ACCOUNT = `reclaim-account-${Math.random().toString(36).substring(2, 9)}`;
const GHOST = `az-ghost-${Math.random().toString(36).substring(2, 9)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  redis = new Redis(REDIS_URL);
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (redis) {
    await redis.srem(WORKERS_SET, GHOST);
    await redis.del(processingKey(GHOST), aliveKey(GHOST));
    await redis.quit();
  }
  if (pool) await pool.end();
});

describe('Phase fix #17：可靠佇列重認領', () => {
  it('死亡 worker 的在途任務被其他 worker 重認領並完成', async () => {
    // 模擬：一個 worker 已用 BLMOVE 把任務移入自己的 processing list 後崩潰（無心跳存活鍵）
    await redis.sadd(WORKERS_SET, GHOST);
    await redis.del(aliveKey(GHOST));
    const task: Task = {
      taskId: 'reclaim-batch',
      accountId: ACCOUNT,
      windowStart: -1,
      transactions: [
        { transactionId: 'reclaim-tx', operationType: OperationType.Credit, amount: 250 },
      ],
    };
    await redis.lpush(processingKey(GHOST), JSON.stringify(task));

    // 等待存活的 worker 偵測到死亡並重認領、再處理
    const deadline = Date.now() + 15000;
    let balance = 0;
    for (;;) {
      const r = await pool.query<{ balance: string }>(
        'SELECT balance FROM accounts WHERE id = $1',
        [ACCOUNT],
      );
      balance = Number(r.rows[0].balance);
      if (balance === 250 || Date.now() > deadline) break;
      await sleep(300);
    }

    expect(balance).toBe(250); // 任務未遺失，已被重認領並套用
    expect(await redis.llen(processingKey(GHOST))).toBe(0); // 死亡 worker 的在途任務已清空
  });
});
