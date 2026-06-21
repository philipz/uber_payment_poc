import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { GLOBAL_QUEUE, resultKey } from '../../shared/keys';
import { replayBatch } from '../../shared/operations';
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

// 為 batch 內每筆交易寫一個 error 結果（讓各等待中的 creator 都能即時回應）。
async function writeBatchError(task: Task, error: TaskResult['error']): Promise<void> {
  await Promise.all(
    task.transactions.map((t) =>
      writeResult({ taskId: t.transactionId, accountId: task.accountId, status: 'error', error }),
    ),
  );
}

async function processTask(task: Task): Promise<void> {
  const { accountId, transactions } = task;

  try {
    for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
      if (attempt > 0) {
        // jitter 5~25ms 錯開重試（Phase 3 多 worker 競爭時避免驚群效應）
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      }

      // 整批共用單次讀取
      const read = await pool.query<{ balance: string; version: number }>(
        'SELECT balance, version FROM accounts WHERE id = $1',
        [accountId],
      );
      if (read.rowCount === 0) {
        await writeBatchError(task, 'account not found');
        return;
      }

      const balance = Number(read.rows[0].balance); // BIGINT 以字串回傳，轉數值
      const version = read.rows[0].version;
      // 記憶體中依序重放整批，計算最終餘額與每筆交易後的餘額
      const { newBalance, steps } = replayBatch(balance, transactions);

      // 整批共用單次樂觀鎖寫入：僅當版本未被他人推進時才更新
      const upd = await pool.query(
        'UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3',
        [newBalance, accountId, version],
      );

      if (upd.rowCount === 1) {
        const newVersion = version + 1;
        // 為每筆交易寫各自的結果（該筆之後的餘額 + 整批提交後的版本）。
        // 用 pipeline 將整批結果打包單次往返，降低 RTT 與 Redis 開銷。
        const pipeline = resultRedis.pipeline();
        for (const s of steps) {
          const result: TaskResult = {
            taskId: s.transactionId,
            accountId,
            status: 'ok',
            balance: s.balanceAfter,
            version: newVersion,
            az: config.azId,
          };
          pipeline.set(
            resultKey(s.transactionId),
            JSON.stringify(result),
            'EX',
            RESULT_TTL_SECONDS,
          );
        }
        await pipeline.exec();
        console.log(
          `[${config.serviceName}] batch account=${accountId} window=${task.windowStart} ` +
            `txns=${transactions.length} → 1 read + 1 write, ver ${version}→${newVersion} (az=${config.azId})`,
        );
        return;
      }
      // rowCount === 0：版本衝突，重讀重試
      console.warn(
        `[${config.serviceName}] OCC 衝突 account=${accountId} ver=${version}，重試 ${attempt + 1}`,
      );
    }

    await writeBatchError(task, 'conflict');
  } catch (err) {
    // DB 連線中斷/逾時等：主動寫 error 結果，讓 creator 即時收到 500，不必枯等逾時
    console.error(`[${config.serviceName}] processTask 發生異常:`, err);
    await writeBatchError(task, 'internal').catch(() => {});
  }
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
