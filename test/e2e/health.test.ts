import { describe, expect, it } from 'vitest';

// E2E 煙霧測試：需先 `docker compose up -d --build`。
// CI 會在跑此測試前拉起 stack。
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

describe('Phase 0 端到端煙霧測試', () => {
  it('batch-creator /health 回 200', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('batch-creator');
  });
});
