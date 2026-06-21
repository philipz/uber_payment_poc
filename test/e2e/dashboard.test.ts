import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { OperationType, type DomainEvent } from '../../src/shared/types';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://poc:poc@localhost:5432/poc';
const ACCOUNT = `dash-account-${Math.random().toString(36).substring(2, 9)}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await pool.query('INSERT INTO accounts (id, balance, version) VALUES ($1, 0, 0)', [ACCOUNT]);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('Phase 5 SSE 儀表板', () => {
  it('GET / 回傳儀表板 HTML', async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('EventSource');
  });

  it('交易的狀態機事件透過 SSE 串流', async () => {
    const ac = new AbortController();
    const res = await fetch(`${BASE_URL}/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: DomainEvent[] = [];

    const readLoop = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              try {
                seen.push(JSON.parse(line.slice(6)) as DomainEvent);
              } catch {
                /* ignore非 JSON 行（如 : connected） */
              }
            }
          }
        }
      } catch {
        /* abort 時的讀取中斷，忽略 */
      }
    })();

    await sleep(200); // 確保訂閱已就緒

    const AMOUNT = 432;
    const post = await fetch(`${BASE_URL}/accounts/${ACCOUNT}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionId: randomUUID(),
        operationType: OperationType.Credit,
        amount: AMOUNT,
      }),
    });
    expect(post.status).toBe(200);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (seen.some((e) => e.accountId === ACCOUNT && e.state === 'Committed')) break;
      await sleep(100);
    }
    ac.abort();
    await readLoop;

    const mine = seen.filter((e) => e.accountId === ACCOUNT);
    const states = new Set(mine.map((e) => e.state));
    expect(states.has('Ingested')).toBe(true);

    const committed = mine.find((e) => e.state === 'Committed');
    expect(committed).toBeDefined();
    expect(committed!.version).toBe(1);
    expect(committed!.balance).toBe(AMOUNT);
    expect(committed!.az).toMatch(/^az-/);
  });
});
