import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { execSync } from 'node:child_process';
import { MICRO_UAC_SIZE, unpackMicroUAC } from '../../src/shared/microuac';

const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = 'hot-account-1';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  
  // 1. 重置 hot-account-1 的狀態以確保乾淨的測試環境
  console.log('🔄 重置 hot-account-1 的帳戶餘額與審計歷史...');
  await pool.query('UPDATE accounts SET balance = 0, version = 0 WHERE id = $1', [ACCOUNT]);
  await pool.query('DELETE FROM audit WHERE account_id = $1', [ACCOUNT]);
  await pool.query('DELETE FROM processed_transactions WHERE account_id = $1', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('E2E 隨機金額負載與審計一致性驗證', () => {
  it('執行負載產生器，並核對所有隨機金額與審計軌跡是否 100% 一致且無遺漏', async () => {
    // 2. 執行 load-generator (會使用剛才修改為 1~10 隨機金額的 runner.ts)
    console.log('🚀 開始執行 load-generator 負載測試 (CONCURRENCY=25, DURATION=3000ms)...');
    const output = execSync(
      'docker compose --profile tools run --rm -e LOAD_CONCURRENCY=25 -e LOAD_DURATION_MS=3000 load-generator',
      { encoding: 'utf-8' }
    );
    console.log('📋 Load Generator 執行輸出：\n', output);

    // 等待一小段時間確保非同步任務與資料庫完全落庫與寫入 metrics
    await new Promise((r) => setTimeout(r, 2000));

    // 3. 查詢最新帳戶餘額與版本
    const accountRes = await pool.query<{ balance: string; version: number }>(
      'SELECT balance, version FROM accounts WHERE id = $1',
      [ACCOUNT]
    );
    const dbBalance = BigInt(accountRes.rows[0].balance);
    const dbVersion = accountRes.rows[0].version;

    // 4. 查詢所有 audit 記錄中的 micro_uac
    const auditRes = await pool.query<{ micro_uac: Buffer; status: string }>(
      'SELECT micro_uac, status FROM audit WHERE account_id = $1 ORDER BY id ASC',
      [ACCOUNT]
    );
    const auditRows = auditRes.rows;

    // 5. 查詢 processed_transactions 去重表記錄
    const processedRes = await pool.query<{ transaction_id: string }>(
      'SELECT transaction_id FROM processed_transactions WHERE account_id = $1',
      [ACCOUNT]
    );
    const processedCount = processedRes.rowCount;

    console.log(`📊 統計數據：`);
    console.log(`  - 帳戶最新餘額 (dbBalance): ${dbBalance}`);
    console.log(`  - 帳戶更新版本 (dbVersion): ${dbVersion}`);
    console.log(`  - 審計表記錄筆數 (auditCount): ${auditRows.length}`);
    console.log(`  - 交易去重表記錄筆數 (processedCount): ${processedCount}`);

    // 6. 解碼所有 micro_uac 並累加金額，同時驗證每個記錄的內容
    let sumAmount = 0n;
    let index = 0;
    for (const row of auditRows) {
      expect(row.status).toBe('Committed');
      expect(row.micro_uac.length).toBe(MICRO_UAC_SIZE);
      
      const unpacked = unpackMicroUAC(row.micro_uac);
      sumAmount += unpacked.amount;
      
      // 驗證隨機金額範圍在 1~10 之間
      expect(Number(unpacked.amount)).toBeGreaterThanOrEqual(1);
      expect(Number(unpacked.amount)).toBeLessThanOrEqual(10);
      
      index++;
    }

    console.log(`🧮 累加解碼金額 (sumAmount): ${sumAmount}`);

    // 7. 驗證一致性
    // (a) 審計筆數必須與去重表筆數完全相等，保證沒有交易遺漏
    expect(auditRows.length).toBe(processedCount);
    
    // (b) 解碼累加後的總金額，必須與資料庫中帳戶的最新餘額完全相等
    expect(sumAmount).toBe(dbBalance);
    
    console.log('✅ 金額一致性與零遺漏驗證通過！');
  }, 30000); // 設定超時為 30 秒，因為需要執行 3 秒的 load-generator
});
