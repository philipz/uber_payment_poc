import { randomUUID } from 'node:crypto';
import { OperationType, type Mode } from '../../shared/types';

export interface ScenarioResult {
  mode: Mode;
  requests: number; // 成功提交的請求數
  dbWrites: number; // 期間 DB 寫入次數
  ratio: number; // 壓縮比 = requests / dbWrites
  elapsedMs: number;
  throughput: number; // req/s
  avgLatencyMs: number;
}

export interface RunOptions {
  baseUrl: string;
  account: string;
  concurrency: number;
  durationMs: number;
}

interface Metrics {
  batched: { requests: number; dbWrites: number };
  naive: { requests: number; dbWrites: number };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readMetrics(baseUrl: string): Promise<Metrics> {
  const res = await fetch(`${baseUrl}/metrics`);
  return (await res.json()) as Metrics;
}

export async function runScenario(opts: RunOptions, mode: Mode): Promise<ScenarioResult> {
  const before = await readMetrics(opts.baseUrl);
  const url =
    `${opts.baseUrl}/accounts/${opts.account}/transactions` +
    (mode === 'naive' ? '?mode=naive' : '');

  let success = 0;
  let latencySum = 0;
  const start = Date.now();
  const deadline = start + opts.durationMs;

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            transactionId: randomUUID(),
            operationType: OperationType.Credit,
            amount: 1,
          }),
        });
        await res.text();
        if (res.ok) {
          success++;
          latencySum += Date.now() - t0;
        }
      } catch {
        /* 忽略單筆錯誤，繼續灌 */
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  const elapsedMs = Date.now() - start;
  await sleep(500); // 等待在途批次提交，計數穩定

  const after = await readMetrics(opts.baseUrl);
  const dbWrites = after[mode].dbWrites - before[mode].dbWrites;
  return {
    mode,
    requests: success,
    dbWrites,
    ratio: dbWrites > 0 ? success / dbWrites : success,
    elapsedMs,
    throughput: success / (elapsedMs / 1000),
    avgLatencyMs: success > 0 ? latencySum / success : 0,
  };
}

// 依序跑 batched 與 naive，回傳兩者結果供對照。
export async function runComparison(
  opts: RunOptions,
): Promise<{ batched: ScenarioResult; naive: ScenarioResult }> {
  const batched = await runScenario(opts, 'batched');
  const naive = await runScenario(opts, 'naive');
  return { batched, naive };
}
