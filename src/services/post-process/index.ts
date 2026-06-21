import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { AUDIT_QUEUE } from '../../shared/keys';
import { emitEvent } from '../../shared/events';
import { TxnState, type AuditJob } from '../../shared/types';

const config = loadConfig();
// 健康檢查伺服器（供 compose healthcheck 用）
startHealthServer(config.port, config.serviceName);

const queueRedis = createRedis(config); // 專用於阻塞式 BRPOP
const pubRedis = createRedis(config); // 發布領域事件
const pool = new Pool({ connectionString: config.databaseUrl });

// 將一個 batch 的 MicroUAC 持久化至審計庫，並對下游發布事件（Kafka stub）。
async function persist(job: AuditJob): Promise<void> {
  if (job.microUacs.length === 0) return;
  // 單條多列 bulk insert，省去逐筆 RTT
  const values: unknown[] = [];
  const placeholders = job.microUacs.map((hex, idx) => {
    const base = idx * 3;
    values.push(job.accountId, Buffer.from(hex, 'hex'), 'Committed');
    return `($${base + 1}, $${base + 2}, $${base + 3})`;
  });
  await pool.query(
    `INSERT INTO audit (account_id, micro_uac, status) VALUES ${placeholders.join(', ')}`,
    values,
  );
  // Kafka stub：以 stdout 模擬向下游發布變更事件
  console.log(
    `[${config.serviceName}] kafka(stub) 發布變更事件 account=${job.accountId} records=${job.microUacs.length}`,
  );

  void emitEvent(pubRedis, {
    ts: Date.now(),
    state: TxnState.Finalized,
    accountId: job.accountId,
    batchId: job.batchId,
    size: job.microUacs.length,
  });
}

async function workLoop(): Promise<void> {
  console.log(`[${config.serviceName}] post-process up，開始消費審計佇列`);
  for (;;) {
    try {
      // PoC 限制：BRPOP 為破壞性讀取，at-most-once —— 若 persist 失敗該筆審計即遺失。
      // 生產應改用 BLMOVE 可靠佇列（移至 processing queue + 失敗復原重試）以確保零丟失。
      const popped = await queueRedis.brpop(AUDIT_QUEUE, 5);
      if (!popped) continue; // 逾時，繼續等待
      await persist(JSON.parse(popped[1]) as AuditJob);
    } catch (err) {
      console.error(`[${config.serviceName}] persist error:`, err);
    }
  }
}

void workLoop();
