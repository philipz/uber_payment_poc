import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { AUDIT_QUEUE, GLOBAL_QUEUE, dbWritesKey, resultKey } from '../../shared/keys';
import { dedupeTransactions, replayBatch, type ReplayStep } from '../../shared/operations';
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

  const mode = task.mode ?? 'batched';
  const uniqueTxids = [...new Set(transactions.map((t) => t.transactionId))];

  try {
    for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
      if (attempt > 0) {
        // jitter 5~25ms 錯開重試（Phase 3 多 worker 競爭時避免驚群效應）
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
      }

      // 讀取 → 去重 → OCC 寫入 → 記錄已套用 txid，全部在「同一個 DB 交易」內原子完成。
      const client = await pool.connect();
      let outcome: 'committed' | 'conflict' | 'no-account' = 'conflict';
      let newBalance = 0;
      let committedVersion = 0;
      let appliedTxns: TransactionInput[] = [];
      let appliedSteps: ReplayStep[] = [];
      try {
        await client.query('BEGIN');
        const read = await client.query<{ balance: string; version: number }>(
          'SELECT balance, version FROM accounts WHERE id = $1',
          [accountId],
        );
        if (read.rowCount === 0) {
          await client.query('ROLLBACK');
          outcome = 'no-account';
        } else {
          const balance = Number(read.rows[0].balance); // BIGINT 以字串回傳，轉數值
          const version = read.rows[0].version;

          // 交易級冪等：排除「已套用」與「批次內重複」的 txid，只重放真正的新交易
          const existing = await client.query<{ transaction_id: string }>(
            'SELECT transaction_id FROM processed_transactions WHERE transaction_id = ANY($1)',
            [uniqueTxids],
          );
          const processedSet = new Set(existing.rows.map((r) => r.transaction_id));
          appliedTxns = dedupeTransactions(transactions, processedSet);

          if (appliedTxns.length === 0) {
            // 全部為重複：無餘額變更，提交 no-op，回應目前狀態（冪等）
            await client.query('COMMIT');
            newBalance = balance;
            committedVersion = version;
            outcome = 'committed';
          } else {
            const replay = replayBatch(balance, appliedTxns);
            newBalance = replay.newBalance;
            appliedSteps = replay.steps;
            const upd = await client.query(
              'UPDATE accounts SET balance = $1, version = version + 1 WHERE id = $2 AND version = $3',
              [newBalance, accountId, version],
            );
            if (upd.rowCount !== 1) {
              await client.query('ROLLBACK');
              outcome = 'conflict';
            } else {
              // 同事務記錄已套用 txid，保證「餘額變更」與「冪等標記」原子一致
              const values: unknown[] = [];
              const placeholders = appliedTxns.map((t, i) => {
                const b = i * 3;
                values.push(t.transactionId, accountId, version + 1);
                return `($${b + 1}, $${b + 2}, $${b + 3})`;
              });
              await client.query(
                `INSERT INTO processed_transactions (transaction_id, account_id, applied_version) ` +
                  `VALUES ${placeholders.join(', ')} ON CONFLICT (transaction_id) DO NOTHING`,
                values,
              );
              await client.query('COMMIT');
              committedVersion = version + 1;
              outcome = 'committed';
            }
          }
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      if (outcome === 'no-account') {
        await writeBatchError(task, 'account not found');
        return;
      }
      if (outcome === 'conflict') {
        console.warn(`[${config.serviceName}] OCC 衝突 account=${accountId}，重試 ${attempt + 1}`);
        continue;
      }

      // outcome === 'committed'（可能為 no-op）
      const didWrite = appliedTxns.length > 0;
      if (didWrite) {
        resultRedis.incr(dbWritesKey(mode)).catch((err) => {
          console.error(`[${config.serviceName}] dbWrites metric incr failed:`, err);
        });
      }

      // 為所有原始 unique txid 寫結果：新交易用其重放後餘額，重複交易用最終提交餘額（冪等回應）
      const stepBalance = new Map(appliedSteps.map((s) => [s.transactionId, s.balanceAfter]));
      const pipeline = resultRedis.pipeline();
      for (const txid of uniqueTxids) {
        const result: TaskResult = {
          taskId: txid,
          accountId,
          status: 'ok',
          balance: stepBalance.get(txid) ?? newBalance,
          version: committedVersion,
          az: config.azId,
        };
        pipeline.set(resultKey(txid), JSON.stringify(result), 'EX', RESULT_TTL_SECONDS);
      }
      await pipeline.exec();

      // 審計只記真正套用的新交易（不佔交易關鍵路徑，獨立 try-catch 不影響已提交結果）
      if (didWrite) {
        try {
          const microUacs = appliedTxns.map((t, i) => microUacHexFor(t, i, committedVersion));
          const auditJob: AuditJob = { accountId, batchId: task.taskId, microUacs };
          await resultRedis.lpush(AUDIT_QUEUE, JSON.stringify(auditJob));
        } catch (auditErr) {
          console.error(`[${config.serviceName}] 寫入審計佇列失敗（non-blocking）:`, auditErr);
        }
      }

      void emitEvent(resultRedis, {
        ts: Date.now(),
        state: TxnState.Committed,
        accountId,
        batchId: task.taskId,
        windowStart: task.windowStart,
        size: appliedTxns.length,
        version: committedVersion,
        balance: newBalance,
        az: config.azId,
      });

      console.log(
        `[${config.serviceName}] batch account=${accountId} window=${task.windowStart} ` +
          `txns=${transactions.length} applied=${appliedTxns.length} → ${didWrite ? '1 read + 1 write' : 'no-op(dup)'}, ` +
          `ver ${committedVersion} (az=${config.azId})`,
      );
      return;
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
