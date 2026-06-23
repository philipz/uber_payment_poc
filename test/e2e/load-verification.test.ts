import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { execSync } from 'node:child_process';
import { MICRO_UAC_SIZE, unpackMicroUAC } from '../../src/shared/microuac';

const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
// 用獨立帳號隔離，避免與其他並行 e2e 測試共用 hot-account-1 互相干擾
const ACCOUNT = `load-verify-${Math.random().toString(36).substring(2, 9)}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('E2E 隨機金額負載與審計一致性驗證', () => {
  it('執行負載產生器，核對所有隨機金額與審計軌跡 100% 一致且無遺漏', async () => {
    // 對獨立帳號跑 load-generator（runner 以 1~10 隨機金額 credit），含 batched 與 naive 兩模式
    const output = execSync(
      `docker compose --profile tools run --rm ` +
        `-e LOAD_ACCOUNT=${ACCOUNT} -e LOAD_CONCURRENCY=25 -e LOAD_DURATION_MS=3000 load-generator`,
      { encoding: 'utf-8' },
    );
    console.log('load-generator output:\n', output);

    // 等待在途批次與審計完全落庫
    await new Promise((r) => setTimeout(r, 2000));

    const accountRes = await pool.query<{ balance: string; version: number }>(
      'SELECT balance, version FROM accounts WHERE id = $1',
      [ACCOUNT],
    );
    const dbBalance = BigInt(accountRes.rows[0].balance);

    const auditRes = await pool.query<{ micro_uac: Buffer; status: string }>(
      'SELECT micro_uac, status FROM audit WHERE account_id = $1 ORDER BY id ASC',
      [ACCOUNT],
    );
    const auditRows = auditRes.rows;

    const processedRes = await pool.query<{ transaction_id: string }>(
      'SELECT transaction_id FROM processed_transactions WHERE account_id = $1',
      [ACCOUNT],
    );
    const processedCount = processedRes.rowCount;

    // 解碼每筆 micro_uac、累加金額，並驗證內容
    let sumAmount = 0n;
    for (const row of auditRows) {
      expect(row.status).toBe('Committed');
      expect(row.micro_uac.length).toBe(MICRO_UAC_SIZE);
      const unpacked = unpackMicroUAC(row.micro_uac);
      sumAmount += unpacked.amount;
      // runner 產生的隨機金額落在 1~10
      expect(Number(unpacked.amount)).toBeGreaterThanOrEqual(1);
      expect(Number(unpacked.amount)).toBeLessThanOrEqual(10);
    }

    // 應有實際負載產生
    expect(auditRows.length).toBeGreaterThan(0);
    // (a) 審計筆數 == 去重表筆數：無交易遺漏、無重複
    expect(auditRows.length).toBe(processedCount);
    // (b) 解碼累加金額 == 帳戶最新餘額：每筆隨機金額皆正確落帳
    expect(sumAmount).toBe(dbBalance);
  }, 30000);
});
