import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { GLOBAL_QUEUE, resultKey } from '../../shared/keys';
import { applyOperation } from '../../shared/operations';
import type { Task, TaskResult } from '../../shared/types';

const config = loadConfig();
// 健康檢查伺服器（worker 非 HTTP 對外，但供 compose healthcheck 用）
startHealthServer(config.port, config.serviceName);

const queueRedis = createRedis(config); // 專用於阻塞式 BRPOP
const resultRedis = createRedis(config);
const pool = new Pool({ connectionString: config.databaseUrl });

const RESULT_TTL_SECONDS = 30;
const MAX_OCC_RETRIES = 5;

async function writeResult(result: TaskResult): Promise<void> {
  await resultRedis.set(resultKey(result.taskId), JSON.stringify(result), 'EX', RESULT_TTL_SECONDS);
}

async function processTask(task: Task): Promise<void> {
  const { taskId, accountId, transaction } = task;

  for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
    const read = await pool.query<{ balance: string; version: number }>(
      'SELECT balance, version FROM accounts WHERE id = $1',
      [accountId],
    );
    if (read.rowCount === 0) {
      await writeResult({ taskId, accountId, status: 'error', error: 'account not found' });
      return;
    }

    const balance = Number(read.rows[0].balance); // BIGINT 以字串回傳，轉數值
    const version = read.rows[0].version;
    const newBalance = applyOperation(balance, transaction.operationType, transaction.amount);

    // 樂觀鎖條件寫入：僅當版本未被他人推進時才更新
    const upd = await pool.query(
      'UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3',
      [newBalance, accountId, version],
    );

    if (upd.rowCount === 1) {
      await writeResult({
        taskId,
        accountId,
        status: 'ok',
        balance: newBalance,
        version: version + 1,
        az: config.azId,
      });
      return;
    }
    // rowCount === 0：版本衝突，重讀重試
    console.warn(
      `[${config.serviceName}] OCC 衝突 account=${accountId} ver=${version}，重試 ${attempt + 1}`,
    );
  }

  await writeResult({ taskId, accountId, status: 'error', error: 'conflict' });
}

async function workLoop(): Promise<void> {
  console.log(`[${config.serviceName}] worker up (az=${config.azId})，開始領取任務`);
  for (;;) {
    try {
      const popped = await queueRedis.brpop(GLOBAL_QUEUE, 5);
      if (!popped) continue; // 逾時，繼續等待
      const task = JSON.parse(popped[1]) as Task;
      await processTask(task);
    } catch (err) {
      console.error(`[${config.serviceName}] work loop error:`, err);
    }
  }
}

void workLoop();
