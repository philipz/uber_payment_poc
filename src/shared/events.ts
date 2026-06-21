import type Redis from 'ioredis';
import { EVENTS_CHANNEL } from './keys';
import type { DomainEvent } from './types';

// 發布一個領域事件：同一份事件既廣播到 Redis（→ creator → SSE 儀表板）也寫 stdout log。
// 這是狀態機事件的「單一事實來源」。
export async function emitEvent(pub: Redis, event: DomainEvent): Promise<void> {
  const payload = JSON.stringify(event);
  const detail = [
    event.transactionId ? `txn=${event.transactionId}` : '',
    event.batchId ? `batch=${event.batchId}` : '',
    event.az ? `az=${event.az}` : '',
    event.version !== undefined ? `ver=${event.version}` : '',
    event.balance !== undefined ? `bal=${event.balance}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[event] ${event.state} account=${event.accountId} ${detail}`.trimEnd());
  try {
    await pub.publish(EVENTS_CHANNEL, payload);
  } catch (err) {
    // 事件廣播失敗不可影響主流程
    console.error('[event] publish failed (non-blocking):', err);
  }
}
