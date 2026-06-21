import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { AUDIT_QUEUE, GLOBAL_QUEUE, resultKey } from '../../shared/keys';
import { replayBatch } from '../../shared/operations';
import { packMicroUAC } from '../../shared/microuac';
import { emitEvent } from '../../shared/events';
import {
  TxnState,
  type AuditJob,
  type Task,
  type TaskResult,
  type TransactionInput,
} from '../../shared/types';

const config = loadConfig();
// 健康檢查伺服器（worker 非 HTTP 對外，但供 compose healthcheck 用）
startHealthServer(config.port, config.serviceName);

const queueRedis = createRedis(config); // 專用於阻塞式 BRPOP
const resultRedis = createRedis(config);
const pool = new Pool({ connectionString: config.databaseUrl });

const RESULT_TTL_SECONDS = 30;
// 多 worker 同時處理同一賬戶的不同批次時會發生 OCC 衝突，需足夠重試次數確保最終都能提交
const MAX_OCC_RETRIES = 20;

// 由一筆交易產生 48-byte MicroUAC 的 hex。
// transactionId 為字串，取其 MD5 前 8 bytes 收斂為 Int64（PoC 適配）；ReferenceHash 為 referenceId 的 MD5。
function microUacHexFor(
  txn: TransactionInput,
  sequenceNumber: number,
  accountVersion: number,
): string {
  const tidHash = createHash('md5').update(txn.transactionId).digest();
  const transactionId = BigInt.asIntN(64, tidHash.readBigUInt64BE(0));
  const referenceHash = createHash('md5')
    .update(txn.referenceId ?? txn.transactionId)
    .digest();
  return packMicroUAC({
    transactionId,
    operationType: txn.operationType,
    amount: BigInt(txn.amount),
    sequenceNumber,
    accountVersion,
    referenceHash,
    businessTime: txn.businessTime ?? Math.floor(Date.now() / 1000),
  }).toString('hex');
}

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

  void emitEvent(resultRedis, {
    ts: Date.now(),
    state: TxnState.Processing,
    accountId,
    batchId: task.taskId,
    windowStart: task.windowStart,
    size: transactions.length,
    az: config.azId,
  });

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

        // 結果已寫入（creator 可回應），再把審計推給後處理非同步落庫（不佔交易關鍵路徑）。
        // 用獨立 try-catch：審計入列失敗屬非關鍵路徑，絕不可覆寫已成功提交的交易結果（避免 dual-write 不一致）。
        try {
          const microUacs = transactions.map((t, i) => microUacHexFor(t, i, newVersion));
          const auditJob: AuditJob = { accountId, batchId: task.taskId, microUacs };
          await resultRedis.lpush(AUDIT_QUEUE, JSON.stringify(auditJob));
        } catch (auditErr) {
          console.error(`[${config.serviceName}] 寫入審計佇列失敗（non-blocking）:`, auditErr);
        }

        void emitEvent(resultRedis, {
          ts: Date.now(),
          state: TxnState.Committed,
          accountId,
          batchId: task.taskId,
          windowStart: task.windowStart,
          size: transactions.length,
          version: newVersion,
          balance: newBalance,
          az: config.azId,
        });

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
