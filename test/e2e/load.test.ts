import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runComparison } from '../../src/services/load-generator/runner';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = `load-account-${Math.random().toString(36).substring(2, 9)}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('Phase 6 對照組：批次 vs 天真單筆', () => {
  it('批次模式壓縮比顯著高於天真模式，且兩模式餘額一致', async () => {
    const { batched, naive } = await runComparison({
      baseUrl: BASE_URL,
      account: ACCOUNT,
      concurrency: 15,
      durationMs: 1500,
    });

    // 兩模式都應有成功請求
    expect(batched.requests).toBeGreaterThan(0);
    expect(naive.requests).toBeGreaterThan(0);

    // 批次壓縮比應明顯 > 1，且遠高於天真（天真近 1:1）
    expect(batched.ratio).toBeGreaterThan(2);
    expect(batched.ratio).toBeGreaterThan(naive.ratio * 1.5);

    // 餘額一致性：runner 每筆 credit 隨機 1~10，故最終餘額應落在 [成功數, 成功數×10]
    const total = batched.requests + naive.requests;
    const r = await pool.query<{ balance: string }>('SELECT balance FROM accounts WHERE id = $1', [
      ACCOUNT,
    ]);
    const balance = Number(r.rows[0].balance);
    expect(balance).toBeGreaterThanOrEqual(total);
    expect(balance).toBeLessThanOrEqual(total * 10);
  });
});
