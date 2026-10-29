# Quint model report — philipz/uber_payment_poc（Issue #70，階段②）

- Repo：`philipz/uber_payment_poc`
- 驗證基準：`main` @ `672fc88945e7923cb392530a852c38e508f54f21`
- 規則來源：`specs/quint/RULES.md`（G1 確認版 v2，**唯讀**；本階段未修改、未擴充）
- 程式證據：`specs/quint/CODE-SUMMARY.md`（grill 階段產出，唯讀）
- 工具：Quint CLI `0.33.1`，backend `rust`；只使用 `quint typecheck` 與 `quint run`
- 本階段**未執行** `quint verify`（ADR-029 §7：Apalache／Java 不在本階段工具鏈）
- 範圍：batched 路徑（RULES.md Q8 / OUT-10）；naive、SSE 順序、跨帳戶 txid、多 creator 不在模型內

> **結果性質**：以下 `quint run` 結果是**隨機取樣**，不是窮盡證明。通過只代表在指定
> `--max-steps`／`--max-samples`／seed 下未見反例；`quint verify` 未執行。

## 1. 模型結構

- 單一 `var world: World`，包含 Redis bucket／時間、Postgres accounts／processed／audit、
  任務佇列、兩個 worker 的 attempt 區域狀態，以及唯讀用的 instrumentation
  （`applied`、`commits`、`finalizes`、`reads`、`conflicts`）。
- 一個 action 對應一個可觀察事件：`Ingest`（ACCUMULATE_LUA）、`TimerClose`（CLOSE_ONE_LUA）、
  `Sweep`（SWEEP_LUA）、`Acquire`（BLMOVE）、`Read`、`Commit`／`Noop`／`Conflict`／`GiveUp`、
  `Reclaim`、`Tick`。
- **併發**：`Acquire` 把 task 從 queue 移給 worker；`Reclaim` 可在 stale attempt 仍存活時把
  同一 task 放回 queue，讓第二個 worker 取得 → 同一 task 的兩個 attempt 可任意交錯
  （RULES.md ENV-3 / Q13）。`Commit` 以 `version == snapshotVersion` 為 OCC guard；
  版本不符只能走 `Conflict`（ROLLBACK → 重讀）或重試耗盡的 `GiveUp`。
- **提前關窗**：`TimerClose` 不檢查 `windowStart + 250`（對應 `CLOSE_ONE_LUA` 不重查
  Redis TIME），所以早於 deadline 的關窗是可達狀態；`Sweep` 則必須 `now >= windowStart + 250`。
- **去重／重放**：`Read` 以當下 `processed` snapshot 過濾，再保留 arrival order 首次出現，
  逐步計算 `balances`；`Commit` 把 balance、processed、audit、finalize 全部放在同一個
  world 更新內（對應同一個 DB transaction）。
- **no-op**：`applied.length == 0` 時走 `Noop`，不改 balance／version／audit，也不 push finalize。

## 2. 規則 → 檢查對照

| RULES | 模型檢查 | 類型 | 結果 |
|---|---|---|---|
| INV-1 守恆 | `INV_1_conservation` | invariant | 5000 samples 未見反例 |
| INV-2 audit = processed = applied | `INV_2_counts` | invariant | 5000 samples 未見反例 |
| INV-3 version = 非 no-op 提交數、每次 +1 | `INV_3_version` | invariant | 5000 samples 未見反例 |
| INV-4 每 txid 至多套用一次 | `INV_4_txid_once` | invariant | 5000 samples 未見反例 |
| INV-5 批次原子性 | `INV_5_atomic` | invariant | 5000 samples 未見反例 |
| INV-6 每筆 applied 恰一筆 48-byte Committed audit | `INV_6_audit` | invariant | 5000 samples 未見反例 |
| INV-7 no-op 不改 balance／version／audit／finalize | `INV_7_noop` | invariant | 5000 samples 未見反例 |
| INV-8 每 `(account, windowStart)` 至多一個 batch/task | `INV_8_single_batch` | invariant | **反例，見 §6 CF-1** |
| INV-9 無「有餘額變更而無 audit」 | `INV_9_no_unaccounted` | invariant | 5000 samples 未見反例 |
| ACT-1 windowStart 對齊 | `ACT_1_window_alignment` + `WIT_ACT_1_aligned_bucket` | invariant + witness | 通過／witness 100% |
| ACT-2 非空窗恰一 task | `ACT_2_close_task` + `WIT_ACT_2_task_from_nonempty_window` | invariant + witness | 通過／witness 100% |
| ACT-3 批次重放 | `ACT_3_replay_order` + `WIT_ACT_3_multi_txn_replay` | invariant + witness | 通過／witness 38.65% |
| ACT-4 OCC 與重試 | `ACT_4_occ` + `WIT_ACT_4_conflict_then_commit` | invariant + witness | 通過／witness 28.55% |
| ACT-5 批次內 arrival order | `ACT_3_replay_order` + `WIT_ACT_5_order_sensitive_commit` | invariant + witness | 通過／witness 11.80% |
| ACT-6 重試安全 | `ACT_6_retry_safe` + `WIT_ACT_6_retry_is_noop` | invariant + witness | 通過／witness 30.35%（HTTP 語意見 §7） |
| ACT-7 兩條關窗路徑 | `ACT_7_close_paths` + `WIT_ACT_7_early_timer_close` / `WIT_ACT_7_sweep_after_deadline` | invariant + witness | 通過／witness 99.05% / 72.15% |
| ACT-8 兩個 attempt 可交錯 | `WIT_ACT_8_two_reads_same_snapshot` | reachability witness | 18.15%（不是 invariant） |
| ENV-1 payload 固定 | `ENV_1_payload` | premise check | 5000 samples 未見反例 |
| ENV-2／Q12 輸入域 | `ENV_2_amount_domain` | premise check | 5000 samples 未見反例 |
| Q9 sequenceNumber = applied index | `WIT_Q9_sequence_compacted` + `INV_6_audit` | witness + invariant | 17.70%／通過 |

補充：

- **ACT-2 的 `Queued` 事件**未建模。Q5／OUT-9 已把事件流排除在不變量之外；模型檢查的是
  「非空 bucket 關閉後恰一個 task」，不含事件送達。
- **ACT-4 的重試耗盡**（20 次 → 409）有建成 `GiveUp` 路徑，但在 `--max-steps=60` 內未被
  witness 到；本次沒有為它產生 trace。`Conflict` 路徑本身有 witness（28.55%）。
- `INV_4`、`INV_1` 在「同一 task 兩個 attempt 讀到同一 snapshot」的情境下仍成立：先提交者
  推進 version，後提交者的 OCC guard 失敗，重讀後 `processed` 已含該 txid，走 no-op。
  本次取樣的 `WIT_ACT_8_two_reads_same_snapshot` 覆蓋了這個交錯。

## 3. 實例與常數

單一實例 `main`（`--main=main`）；所有值集中在 `instances.qnt` 的 `config` 模組，
`test.qnt` 也從同一個 `config` 綁定，避免兩份值漂移。

| 常數 | 值 | 理由（domain_justification） |
|---|---|---|
| `ACCOUNTS` | `{ "hot-account-1" }` | `db/init.sql:33-35` 只 seed 此帳戶；程式只檢查 `^[A-Za-z0-9_-]+$`（`src/services/batch-creator/index.ts:68,182-186`），未知帳戶 404（`src/services/batch-process/index.ts:120-123,207-209`）。抽一個帳戶是狀態空間取樣，不是程式限制。 |
| `INITIAL_BALANCE` | `hot-account-1 -> 0` | `db/init.sql:6` 預設 0、`:33-35` seed 0；程式未限制初始餘額。 |
| `TXN_IDS` | `tx-1..tx-5` | `transactionId` 只要求非空字串（`src/services/batch-creator/index.ts:132`），無其他上界；抽樣 5 個 id。 |
| `TXN_ACCOUNT` | 全部 `hot-account-1` | ENV-1：同一 txid 的 payload 固定。程式在重試時**不**驗證 account/payload（`src/services/batch-process/index.ts:128-143`），這是 RULES.md 明列的上游前提，不是模型自行加的假設。 |
| `TXN_OP` | `1,2,3,4,1` | `OperationType` 1..4（`src/shared/types.ts:4-9`；輸入檢查 `batch-creator/index.ts:133`）；四種 operation 都涵蓋。 |
| `TXN_AMOUNT` | `1,2,3,4,9007199254740991` | 程式只要求正整數、**無上界**（`src/services/batch-creator/index.ts:134`）。1 是最小值、2 為偶數、`2^53-1` 是 JS `number` 可精確表示的最大整數（amount 先以 JS number 進出）。這是取樣域，不是程式限制；模型沒有用 `assume` 縮小它。 |
| `WINDOW_MS` | `250`（pure val） | `src/shared/keys.ts:6`；Lua `floor(now/windowMs)*windowMs`（`src/shared/lua.ts:13-15`）。 |
| `MAX_OCC_RETRIES` | `20`（pure val） | `src/services/batch-process/index.ts:37`。 |
| `WORKERS` | `{1, 2}`（pure val） | compose 有 3 個 worker；Q13 只要求「兩個可交錯 attempt」。取 2 是狀態空間取樣，不是程式限制。 |
| `TIME_DELTAS` | `{1,50,100,249,250,500}`（pure val） | Redis TIME 是無限制毫秒時鐘；這些 delta 取樣時間推進，涵蓋 1ms 與 249/250ms window 邊界，重複 step 可到任何 offset。 |
| `INITIAL_VERSION` | `0`（pure val） | `db/init.sql:6,33-35` 的 version 預設／seed 為 0。 |
| `OP_*` | `1..4`（pure val） | `OperationType` 的數值（`src/shared/types.ts:4-9`）。 |

## 4. 執行命令與牆鐘

牆鐘是 `time` 量測整個 process（含 Node／Quint 啟動約 2 秒），非 simulator 內部的
`(Nms at …)` 數字。每條 `quint run` 都是取樣，不是證明。

| # | 命令 | 牆鐘 |
|---|---|---:|
| 1 | `quint typecheck specs/quint/model.qnt` | 2.03s |
| 2 | `quint typecheck specs/quint/instances.qnt` | 2.10s |
| 3 | `quint typecheck specs/quint/test.qnt` | 2.47s |
| 4 | `quint run specs/quint/instances.qnt --main=main --max-steps=60 --max-samples=5000 --invariant=INV_1_conservation` | 3.53s |
| 5 | 同上，`--invariant=INV_2_counts` | 3.74s |
| 6 | 同上，`--invariant=INV_3_version` | 3.58s |
| 7 | 同上，`--invariant=INV_4_txid_once` | 3.45s |
| 8 | 同上，`--invariant=INV_5_atomic` | 3.92s |
| 9 | 同上，`--invariant=INV_6_audit` | 3.78s |
| 10 | 同上，`--invariant=INV_7_noop` | 3.41s |
| 11 | 同上，`--invariant=INV_9_no_unaccounted` | 3.62s |
| 12 | 同上，`--invariant=ACT_1_window_alignment` | 3.69s |
| 13 | 同上，`--invariant=ACT_2_close_task` | 3.81s |
| 14 | 同上，`--invariant=ACT_3_replay_order` | 4.16s |
| 15 | 同上，`--invariant=ACT_4_occ` | 3.48s |
| 16 | 同上，`--invariant=ACT_6_retry_safe` | 3.54s |
| 17 | 同上，`--invariant=ACT_7_close_paths` | 3.79s |
| 18 | 同上，`--invariant=ENV_1_payload` | 4.75s |
| 19 | 同上，`--invariant=ENV_2_amount_domain` | 3.48s |
| 20 | `quint run specs/quint/instances.qnt --main=main --max-steps=30 --max-samples=500 --seed=2 --invariant=INV_8_single_batch --out-itf=specs/quint/traces/inv8-early-close.itf.json` | 2.17s（預期 rc=1） |
| 21 | `quint run specs/quint/test.qnt --main=test --max-steps=40 --max-samples=2000 --witnesses <19 個 witness，見 §5>` | 3.13s |

## 5. Witness 結果（`--max-steps=40 --max-samples=2000`）

| Witness | 涵蓋 | 出現率 |
|---|---|---:|
| `WIT_INV_1_balance_changed` | INV-1 | 94.95% |
| `WIT_INV_2_audited_balance` | INV-2 | 95.15% |
| `WIT_INV_3_version_advanced` | INV-3 | 95.15% |
| `WIT_INV_4_two_distinct_applied` | INV-4 | 59.85% |
| `WIT_INV_5_atomic_multi_commit` | INV-5 | 38.65% |
| `WIT_INV_6_committed_audit` | INV-6 | 95.15% |
| `WIT_INV_7_noop_commit` | INV-7 | 30.35% |
| `WIT_INV_8_two_windows_one_task_each` | INV-8（非空洞） | 98.75% |
| `WIT_INV_9_change_has_audit` | INV-9 | 95.15% |
| `WIT_Q9_sequence_compacted` | Q9 | 17.70% |
| `WIT_ACT_1_aligned_bucket` | ACT-1 | 100.00% |
| `WIT_ACT_2_task_from_nonempty_window` | ACT-2 | 100.00% |
| `WIT_ACT_3_multi_txn_replay` | ACT-3 | 38.65% |
| `WIT_ACT_4_conflict_then_commit` | ACT-4 | 28.55% |
| `WIT_ACT_5_order_sensitive_commit` | ACT-5 | 11.80% |
| `WIT_ACT_6_retry_is_noop` | ACT-6 | 30.35% |
| `WIT_ACT_7_early_timer_close` | ACT-7（早關可達） | 99.05% |
| `WIT_ACT_7_sweep_after_deadline` | ACT-7（sweep 尊重 deadline） | 72.15% |
| `WIT_ACT_8_two_reads_same_snapshot` | ACT-8 | 18.15% |

所有 witness 都是正面情境、在 init 為 false，且出現率 > 0；沒有任何 witness 是某條
invariant 的否定。

## 6. 反例清單（一律為**候選發現**，不是已確認缺陷）

### CF-1：提前 timer 關窗可在同一 `(account, windowStart)` 產生第二個 task（INV-8）

- 檢查：`INV_8_single_batch`
- Trace：`specs/quint/traces/inv8-early-close.itf.json`（seed 2）
- 重現命令：見 §4 #20
- Trace 摘要（`now` 單位 ms，`WINDOW_MS=250`）：

  | state | now | bucket | task |
  |---:|---:|---|---|
  | 0 | 0 | 無 | 無 |
  | 1 | 0 | `(hot-account-1, 0)`，`openedAt=0`，`tx-4` | 無 |
  | 2 | 0 | 無（被 timer 關閉） | task 0：`(hot-account-1, 0)`，`closedAt=0`，`closedBy="timer"`，`tx-4` |
  | 3 | 0 | `(hot-account-1, 0)` 重新建立，`openedAt=0`，`tx-3` | task 0 仍在 |
  | 4 | 0 | 無 | task 0 + task 1：`(hot-account-1, 0)`，`closedAt=0`，`closedBy="timer"`，`tx-3` |

- 解讀：兩次關窗都在 `now=0`、deadline 250ms 之前由 timer 觸發，符合 ACT-7／Q1 建模的
  提前關窗路徑。第二次 `Ingest` 在 `now` 未前進時仍算出 `windowStart=0`，因此建立了同一個
  `(account, windowStart)` 的第二個 bucket 與第二個 task，直接違反 INV-8。
- **可能後果（本 trace 尚未觀察到，因 invariant 在 task 2 建立時即停止）**：兩個 task 承載
  不同 txid（`tx-4`、`tx-3`），若都被 worker 處理，兩者都不會被 `processed` 去重，可能在同一
  窗口產生兩次提交（version +2）。是否真的造成重複記帳、以及嚴重度，交由 G2 分類；本階段
  不修改 `src/**`，也不為讓 invariant 消失而改模型。
- 備註：本反例的兩個 task 是不同 txid，因此不是「同一 task 重複投遞」而已；它示範的是
  bucket 被提前刪除後、同一窗口被重新建立的情況。

## 7. 模型邊界與未建模項目

- **HTTP／結果快取**：`result:{txid}`、200／409／504 的對應、last-write-wins 未建模。
  ACT-6 只建模「重試安全」（同一 txid 重送不會重複套用，全重複 → no-op）。RULES Q4 已把
  「409 不保證未套用」列 candidate；本模型不宣稱 HTTP 狀態等於 DB 最終狀態。
- **事件流**：`Queued`／`Committed`／`Finalized`、SSE 順序未建模（Q5／OUT-9）。ACT-2 只檢查
  task 數與內容，不檢查事件。
- **naive 模式**：排除（Q8／OUT-10）。
- **跨帳戶 txid 重用**：排除（Q2／ENV-1／OUT-12）。模型用單一 account，`processed` 以 txid
  為鍵；跨帳戶重用不在取樣域。
- **MicroUAC 位元布局**：只檢查 48 bytes、`status='Committed'`、operation／amount／version／
  sequence；`referenceHash`、`businessTime`、reserved bytes 未建模（Q11／Q12；INV-6 未要求）。
- **多 creator**：排除（Q15／OUT-11）；模型只有一組 bucket／timer。
- **ENV-5 窗口 TTL 遺失**：未建模。它是環境失敗，只會讓未關窗交易不進入 `applied`，不會
  使 INV-1／2／4／5／6／9 產生反例；但模型因此不覆蓋「交易遺失」這個 liveness／durability
  面向（見 §8）。
- **finalize liveness**：`finalizes` 只記錄「非 no-op 提交有 push 一筆」，不模擬
  post-process 消費或 Kafka（OUT-4）。
- **Instrumentation**：`applied`／`commits`／`audits`／`reads`／`conflicts` 是模型內用來陳述
  invariant 的觀測清單，不是額外的 DB table；它們與 `accounts`／`processed` 在同一個 action
  內原子更新，對應程式「同一個 DB transaction」的寫入。

## 8. 未決事項

1. **ACT-2 的 `Queued` 事件**：RULES ACT-2 寫「非空窗恰一 task + 一 `Queued`」，但 Q5／OUT-9
   把事件流排除在不變量外。本模型只檢查 task 數；`Queued` 的恰好一次是否也要列為後續階段的
   檢查，請 G2／G1 裁決。
2. **ACT-6 的 HTTP 語義**：本階段只建模重試安全，沒有建模 200／409／504 與結果快取
   last-write-wins。若 G2 認為 ACT-6 需要涵蓋狀態碼語義，需另開模型或後續階段補。
3. **ENV-5 TTL 遺失**：未建模。若後續階段要求 durability／liveness（例如「窗口內交易最終
   至少被處理一次」），需要新增 bucket 過期 action，並確認它不與 INV-8 的判讀混淆。
4. **ACT-4 重試耗盡**：`GiveUp`（20 次 → 409）已建模，但在目前 step/sample 預算內沒有
   witness。是否需要為它產生專門的反例／witness，請 G2 決定。
5. **Instrumentation 抽象**：INV-1／2／5／6／9 是對模型內 `applied`／`audits` 清單陳述，
   這些清單與 DB 狀態在同一個 action 更新。請確認這個抽象對 G2 的分類足夠，或需要在後續
   階段改成獨立的 DB table 模型。
