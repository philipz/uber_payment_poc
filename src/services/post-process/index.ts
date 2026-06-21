import { loadConfig } from '../../shared/config';
import { startHealthServer } from '../../shared/health';
import { createRedis } from '../../shared/redis';
import { FINALIZE_QUEUE } from '../../shared/keys';
import { emitEvent } from '../../shared/events';
import { TxnState, type FinalizeJob } from '../../shared/types';

const config = loadConfig();
// 健康檢查伺服器（供 compose healthcheck 用）
startHealthServer(config.port, config.serviceName);

const queueRedis = createRedis(config); // 專用於阻塞式 BRPOP
const pubRedis = createRedis(config); // 發布領域事件

// 下游傳播：審計已由 batch-process 在主交易內原子落庫，這裡只做下游通知
// （Kafka stub + Finalized 事件）。此佇列遺失不影響審計（審計已持久化）。
async function publish(job: FinalizeJob): Promise<void> {
  // Kafka stub：以 stdout 模擬向下游發布變更事件
  console.log(
    `[${config.serviceName}] kafka(stub) 發布變更事件 account=${job.accountId} records=${job.count}`,
  );
  void emitEvent(pubRedis, {
    ts: Date.now(),
    state: TxnState.Finalized,
    accountId: job.accountId,
    batchId: job.batchId,
    size: job.count,
  });
}

async function workLoop(): Promise<void> {
  console.log(`[${config.serviceName}] post-process up，開始消費 finalize 通知`);
  for (;;) {
    try {
      const popped = await queueRedis.brpop(FINALIZE_QUEUE, 5);
      if (!popped) continue; // 逾時，繼續等待
      await publish(JSON.parse(popped[1]) as FinalizeJob);
    } catch (err) {
      console.error(`[${config.serviceName}] publish error:`, err);
    }
  }
}

void workLoop();
