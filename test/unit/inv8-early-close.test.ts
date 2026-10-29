import { describe, expect, it } from 'vitest';
import { WINDOW_MS } from '../../src/shared/keys';
import { ACCUMULATE_LUA, CLOSE_ONE_LUA, SWEEP_LUA } from '../../src/shared/lua';
import { OperationType } from '../../src/shared/types';

/**
 * 反例 `inv8-early-close`（G2 verdict = real；見 specs/quint/TRIAGE.md）。
 *
 * - Trace：specs/quint/traces/inv8-early-close.itf.json（seed 2）
 * - 模型：specs/quint/model.qnt `TimerClose` / `ACT_7_close_paths` / `INV_8_single_batch`
 * - 規則：specs/quint/RULES.md INV-8、ACT-7、Q1（timer 相對 Redis TIME 可提前觸發）
 *
 * 真實觸發路徑（單一 creator、單一 Redis）：
 *   1. `ACCUMULATE_LUA`（src/shared/lua.ts:9-27）以 Redis TIME 算出
 *      `windowStart = floor(now / 250) * 250`，並回傳
 *      `msUntilClose = (windowStart + 250) - now`。
 *   2. creator 以 `setTimeout(closeWindow, msUntilClose)` 排關窗
 *      （src/services/batch-creator/index.ts:235）。
 *   3. timer 相對 Redis TIME 提前觸發（RULES.md Q1／ENV-2）：`closeWindow`
 *      （src/services/batch-creator/index.ts:74-80）呼叫 `CLOSE_ONE_LUA`
 *      （src/shared/lua.ts:30-53）。該腳本**不重查 deadline**，直接
 *      `LRANGE` → `ZREM` → `DEL` 把未到期的 bucket 刪掉。
 *   4. 同一 `windowStart` 的新交易此時再進 `ACCUMULATE_LUA`：bucket 已不存在，
 *      `isNew = 1`，於同一個 `(accountId, windowStart)` 建立第二個 bucket。
 *   5. 第二個 timer 關窗 → 第二個 Task（不同 txid），違反 INV-8。
 *
 * 測試策略：缺陷在「Lua 腳本 + timer 邊界」，既有純函式無法單獨重現。以下用與
 * src/shared/lua.ts 同步的**最小記憶體內替身**（注入 Redis TIME）重放 trace，
 * 不依賴 Redis／DB／網路；替身刻意保留「CLOSE_ONE 不重查 deadline」的現況。
 *
 * 修正後：
 *   - 把「可執行重現」的 characterization 斷言**反轉成期望值**（同一個
 *     `(accountId, windowStart)` 只能有一個 Task）；
 *   - 移除「修正後應通過」測試的 `.skip`；
 *   - 讓替身的 `closeOne` 與修正後的行為一致（例如重查 deadline，或改由
 *     sweep 在到期後關窗），再刪掉本段修正說明。
 */

interface TestTxn {
  transactionId: string;
  operationType: OperationType;
  amount: number;
}

interface Bucket {
  key: string;
  accountId: string;
  windowStart: number;
  openedAt: number;
  txns: TestTxn[];
}

interface Task {
  taskId: string;
  accountId: string;
  windowStart: number;
  txns: TestTxn[];
  closedAt: number;
  closedBy: 'timer' | 'sweep';
}

interface ScheduledClose {
  bucketKey: string;
  dueAt: number;
}

const ACCOUNT = 'hot-account-1';

/**
 * 最小記憶體內替身：只實作本反例需要的三個 Lua 腳本語意。
 * `redisNowMs` 代表 Redis TIME——依 Q1／ENV-2，它與 JS timer 是兩個時鐘，
 * 所以 timer 可以在 Redis TIME 尚未到 deadline 時被觸發。
 */
class InMemoryWindowStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly tasks: Task[] = [];
  private readonly timers: ScheduledClose[] = [];

  constructor(private readonly redisNowMs: () => number) {}

  get openBuckets(): Bucket[] {
    return [...this.buckets.values()];
  }

  get closedTasks(): Task[] {
    return [...this.tasks];
  }

  get scheduledCloses(): ScheduledClose[] {
    return [...this.timers];
  }

  /** `ACCUMULATE_LUA` 的逐步移植（src/shared/lua.ts:9-27）。 */
  accumulate(
    accountId: string,
    txn: TestTxn,
  ): { bucketKey: string; windowStart: number; isNew: number; msUntilClose: number } {
    const nowMs = this.redisNowMs();
    const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    const bucketKey = `batch:${windowStart}:${accountId}`;

    const existing = this.buckets.get(bucketKey);
    const isNew = existing === undefined ? 1 : 0;
    const bucket: Bucket = existing ?? {
      key: bucketKey,
      accountId,
      windowStart,
      openedAt: nowMs,
      txns: [],
    };
    bucket.txns.push(txn);
    this.buckets.set(bucketKey, bucket);

    const msUntilClose = windowStart + WINDOW_MS - nowMs;
    if (isNew === 1) {
      this.timers.push({ bucketKey, dueAt: windowStart + WINDOW_MS });
    }
    return { bucketKey, windowStart, isNew, msUntilClose };
  }

  /**
   * `CLOSE_ONE_LUA` 的逐步移植（src/shared/lua.ts:30-53）：`LRANGE` → `ZREM`
   * → `DEL`，**不重查 deadline**；空窗或已關閉回 0。
   */
  closeOne(bucketKey: string, closedBy: 'timer' | 'sweep'): number {
    const bucket = this.buckets.get(bucketKey);
    this.buckets.delete(bucketKey); // redis.call('DEL', bucket) 無條件執行
    if (bucket === undefined || bucket.txns.length === 0) return 0;

    this.tasks.push({
      taskId: bucketKey,
      accountId: bucket.accountId,
      windowStart: bucket.windowStart,
      txns: [...bucket.txns],
      closedAt: this.redisNowMs(),
      closedBy,
    });
    return bucket.txns.length;
  }

  /**
   * 對應 creator 的 `setTimeout(() => closeWindow(bucket), msUntilClose)`：
   * 執行已排定的 callback。此處不檢查 `dueAt`，因為 JS timer 與 Redis TIME
   * 是兩個時鐘（Q1／ENV-2），提前觸發正是本反例的前提。
   */
  fireTimer(bucketKey: string): number {
    const index = this.timers.findIndex((timer) => timer.bucketKey === bucketKey);
    if (index === -1) throw new Error(`no scheduled close for ${bucketKey}`);
    const [timer] = this.timers.splice(index, 1);
    return this.closeOne(timer.bucketKey, 'timer');
  }

  /** `SWEEP_LUA` 的逐步移植（src/shared/lua.ts:74-102）：只關已到期窗口。 */
  sweep(): number {
    const nowMs = this.redisNowMs();
    const due = this.openBuckets.filter((bucket) => bucket.windowStart + WINDOW_MS <= nowMs);
    let flushed = 0;
    for (const bucket of due) {
      if (this.closeOne(bucket.key, 'sweep') > 0) flushed += 1;
      const index = this.timers.findIndex((timer) => timer.bucketKey === bucket.key);
      if (index !== -1) this.timers.splice(index, 1);
    }
    return flushed;
  }
}

const txn = (transactionId: string, operationType: OperationType, amount: number): TestTxn => ({
  transactionId,
  operationType,
  amount,
});

describe('INV-8 反例 inv8-early-close', () => {
  /**
   * 【可執行重現｜characterization】目前程式的錯誤行為：提前的 timer 先關掉
   * bucket，同一窗口的新交易重建 bucket，最後兩個 Task 共用同一個
   * `(accountId, windowStart)`。本測試斷言的是「現在會錯」，因此目前綠燈。
   */
  it('timer 提前關窗後，同一窗口可重建 bucket 並產生第二個 Task（現況錯誤）', () => {
    // 先確認記憶體內替身對應的真實腳本前提仍成立（src/shared/lua.ts）。
    expect(ACCUMULATE_LUA).toContain('local windowStart = math.floor(nowMs / windowMs) * windowMs');
    expect(ACCUMULATE_LUA).toContain(
      'return {windowStart, isNew, (windowStart + windowMs) - nowMs}',
    );
    expect(CLOSE_ONE_LUA).toContain("local items = redis.call('LRANGE', bucket, 0, -1)");
    expect(CLOSE_ONE_LUA).toContain("redis.call('DEL', bucket)");
    expect(SWEEP_LUA).toContain(
      "local due = redis.call('ZRANGEBYSCORE', 'windows:active', 0, nowMs, 'LIMIT', 0, limit)",
    );
    // 缺陷本體：CLOSE_ONE_LUA 沒有比對 now 與 windowStart + WINDOW_MS。
    // 這一行開始失敗時，代表 src 已修正；請依檔案開頭說明反轉下方斷言。
    expect(CLOSE_ONE_LUA).not.toMatch(/windowStart\s*\+\s*windowMs/);

    const clock = { redisNowMs: 0 };
    const store = new InMemoryWindowStore(() => clock.redisNowMs);

    // trace state 1（index 1）：now = 0，tx-4（Release 4）進入 (hot-account-1, 0)。
    const first = store.accumulate(ACCOUNT, txn('tx-4', OperationType.Release, 4));
    expect(first.windowStart).toBe(0);
    expect(first.isNew).toBe(1);
    expect(first.msUntilClose).toBe(WINDOW_MS);
    expect(store.scheduledCloses).toEqual([{ bucketKey: first.bucketKey, dueAt: WINDOW_MS }]);

    // trace state 2（index 2）：timer 在 Redis TIME 仍為 0 時觸發（提前關窗）。
    expect(store.fireTimer(first.bucketKey)).toBe(1);
    expect(store.openBuckets).toHaveLength(0);
    expect(store.closedTasks).toHaveLength(1);
    expect(store.closedTasks[0]).toMatchObject({
      accountId: ACCOUNT,
      windowStart: 0,
      closedAt: 0,
      closedBy: 'timer',
    });
    expect(store.closedTasks[0]?.txns.map((t) => t.transactionId)).toEqual(['tx-4']);

    // trace state 3（index 3）：同一窗口的新交易 tx-3（Authorize 3）重建 bucket。
    const second = store.accumulate(ACCOUNT, txn('tx-3', OperationType.Authorize, 3));
    expect(second.windowStart).toBe(first.windowStart);
    expect(second.isNew).toBe(1); // bucket 已被提前的 timer 刪掉 → 重建
    expect(store.openBuckets).toHaveLength(1);
    expect(store.closedTasks).toHaveLength(1); // task 0 仍在

    // trace state 4（index 4）：第二個 timer 也在 now = 0 觸發 → 第二個 Task。
    expect(store.fireTimer(second.bucketKey)).toBe(1);
    expect(store.closedTasks).toHaveLength(2);

    // 現況錯誤結果：兩個 Task 共用同一個 (accountId, windowStart) = INV-8 反例。
    const taskKeys = store.closedTasks.map((t) => `${t.accountId}@${t.windowStart}`);
    expect(taskKeys).toEqual([`${ACCOUNT}@0`, `${ACCOUNT}@0`]);
    expect(new Set(taskKeys).size).toBe(1);
    expect(store.closedTasks.map((t) => t.txns.map((x) => x.transactionId))).toEqual([
      ['tx-4'],
      ['tx-3'],
    ]);
    for (const task of store.closedTasks) {
      expect(task.closedBy).toBe('timer');
      // 兩次關窗都早於 deadline（windowStart + 250 = 250）。
      expect(task.closedAt).toBeLessThan(task.windowStart + WINDOW_MS);
    }
  });

  /**
   * 【修正後應通過】deadline 前的 timer 必須是 no-op；同一窗口只產生一個 Task，
   * 且該 Task 同時攜帶 tx-4 與 tx-3。修正後移除 `.skip`。
   */
  it.skip('deadline 前的 timer 不關窗，同一 (accountId, windowStart) 只產生一個 Task', () => {
    const clock = { redisNowMs: 0 };
    const store = new InMemoryWindowStore(() => clock.redisNowMs);

    const first = store.accumulate(ACCOUNT, txn('tx-4', OperationType.Release, 4));
    expect(first.msUntilClose).toBe(WINDOW_MS);

    // 提前的 timer 不得刪除未到期的 bucket，也不得推入 Task。
    expect(store.fireTimer(first.bucketKey)).toBe(0);
    expect(store.openBuckets).toHaveLength(1);
    expect(store.closedTasks).toHaveLength(0);

    // 同一窗口的新交易加入既有 bucket，而不是建立第二個 bucket。
    const second = store.accumulate(ACCOUNT, txn('tx-3', OperationType.Authorize, 3));
    expect(second.windowStart).toBe(first.windowStart);
    expect(second.isNew).toBe(0);
    expect(store.openBuckets).toHaveLength(1);
    expect(store.openBuckets[0]?.txns.map((t) => t.transactionId)).toEqual(['tx-4', 'tx-3']);

    // deadline 到期後由 sweep 關窗一次：恰好一個 Task，內容為兩筆交易。
    clock.redisNowMs = WINDOW_MS;
    expect(store.sweep()).toBe(1);
    expect(store.closedTasks).toHaveLength(1);
    expect(store.closedTasks[0]).toMatchObject({
      accountId: ACCOUNT,
      windowStart: 0,
      closedAt: WINDOW_MS,
      closedBy: 'sweep',
    });
    expect(store.closedTasks[0]?.txns.map((t) => t.transactionId)).toEqual(['tx-4', 'tx-3']);
  });
});
