import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { GLOBAL_QUEUE, resultKey } from '../../shared/keys';
import {
  OperationType,
  type Task,
  type TaskResult,
  type TransactionInput,
} from '../../shared/types';

const config = loadConfig();
const redis = createRedis(config);

const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// 驗證並萃取交易輸入；失敗回 null。
function parseTransaction(body: unknown): TransactionInput | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const { transactionId, operationType, amount } = b;
  if (typeof transactionId !== 'string' || transactionId.length === 0) return null;
  if (typeof operationType !== 'number' || !(operationType in OperationType)) return null;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return null;
  return {
    transactionId,
    operationType,
    amount,
    referenceId: typeof b.referenceId === 'string' ? b.referenceId : undefined,
    businessTime: typeof b.businessTime === 'number' ? b.businessTime : undefined,
  };
}

async function pollResult(taskId: string): Promise<TaskResult | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const raw = await redis.get(resultKey(taskId));
    if (raw) return JSON.parse(raw) as TaskResult;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function handleTransaction(
  accountId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid json' });
    }
    const txn = parseTransaction(body);
    if (!txn) return sendJson(res, 400, { error: 'invalid transaction' });

    const task: Task = { taskId: randomUUID(), accountId, transaction: txn };
    await redis.lpush(GLOBAL_QUEUE, JSON.stringify(task));

    const result = await pollResult(task.taskId);
    if (!result) return sendJson(res, 504, { error: 'processing timeout' });
    if (result.status === 'error') {
      const status =
        result.error === 'account not found' ? 404 : result.error === 'conflict' ? 409 : 500;
      return sendJson(res, status, { error: result.error });
    }
    return sendJson(res, 200, {
      accountId: result.accountId,
      balance: result.balance,
      version: result.version,
    });
  } catch (err) {
    console.error(`[${config.serviceName}] handleTransaction error:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
  }
}

const TXN_ROUTE = /^\/accounts\/([^/]+)\/transactions$/;

function routes(req: IncomingMessage, res: ServerResponse): boolean {
  const match = req.url ? TXN_ROUTE.exec(req.url) : null;
  if (req.method === 'POST' && match) {
    void handleTransaction(decodeURIComponent(match[1]), req, res);
    return true;
  }
  return false;
}

startHealthServer(config.port, config.serviceName, routes);
console.log(`[${config.serviceName}] up (az=${config.azId})`);
