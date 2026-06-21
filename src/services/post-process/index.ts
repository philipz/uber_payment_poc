import { Pool } from 'pg';
import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { AUDIT_QUEUE } from '../../shared/keys';
import type { AuditJob } from '../../shared/types';

const config = loadConfig();
// 健康檢查伺服器（供 compose healthcheck 用）
startHealthServer(config.port, config.serviceName);

const queueRedis = createRedis(config); // 專用於阻塞式 BRPOP
const pool = new Pool({ connectionString: config.databaseUrl });

// 將一個 batch 的 MicroUAC 持久化至審計庫，並對下游發布事件（Kafka stub）。
async function persist(job: AuditJob): Promise<void> {
  for (const hex of job.microUacs) {
    const buf = Buffer.from(hex, 'hex');
    await pool.query('INSERT INTO audit (account_id, micro_uac, status) VALUES ($1, $2, $3)', [
      job.accountId,
      buf,
      'Committed',
    ]);
  }
  // Kafka stub：以 stdout 模擬向下游發布變更事件
  console.log(
    `[${config.serviceName}] kafka(stub) 發布變更事件 account=${job.accountId} records=${job.microUacs.length}`,
  );
}

async function workLoop(): Promise<void> {
  console.log(`[${config.serviceName}] post-process up，開始消費審計佇列`);
  for (;;) {
    try {
      const popped = await queueRedis.brpop(AUDIT_QUEUE, 5);
      if (!popped) continue; // 逾時，繼續等待
      await persist(JSON.parse(popped[1]) as AuditJob);
    } catch (err) {
      // PoC：記錄錯誤即可；生產應重試/補償以確保零丟失
      console.error(`[${config.serviceName}] persist error:`, err);
    }
  }
}

void workLoop();
