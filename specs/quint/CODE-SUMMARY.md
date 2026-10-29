# CODE-SUMMARY：philipz/uber_payment_poc（grill／階段①）

> 本檔是形式化驗證服務（ADR-029 §5）grill 階段的**唯讀**分析產出：程式碼摘要、候選規則、第一輪問題。
> 本階段**不改程式碼、不定稿規則、不寫模型**；下列規則除非標 `confirmed`，否則一律只是 `candidate`，
> 必須由 G1 逐條確認或修正後才能進入後續階段。`## RULES.md 草稿` 不是已確認規則。
>
> owner 於階段輸入提供的三條未證實風險提示（加密 artifact 送達，此處**不轉錄原文**）已分別落在
> R-1/R-15（併發重複投遞與 txid 唯一性）、R-14（提前關窗）、R-10（audit sequenceNumber）與 Q1/Q2/Q9/Q13。
> 對照 owner 提示使用的編號：INV-1 ↔ R-2（餘額守恆）、INV-4 ↔ R-1（同一 txid 至多套用一次）、
> INV-6 ↔ R-4（審計完整）、INV-8 ↔ R-14（每窗至多一批）。

## 分析範圍

- **Repo**：`philipz/uber_payment_poc`
- **驗證基準分支**：`main`（本次工作區 HEAD = `672fc88945e7923cb392530a852c38e508f54f21`）
- **分析 glob（依 Issue #69 宣告）**：`src/**`
- **分析方式**：逐檔靜態閱讀；未執行服務、未跑測試、未修改任何既有檔案。`src/**` 以外的檔案僅作旁證
  （schema／測試／文件），不作為規則的唯一依據。

讀過的檔案（行數）：

| 路徑 | 行數 | 用途 |
| --- | ---: | --- |
| `src/shared/types.ts` | 98 | 領域型別、OperationType、TxnState |
| `src/shared/keys.ts` | 27 | Redis key 命名與 TTL/佇列常數 |
| `src/shared/lua.ts` | 102 | ACCUMULATE／CLOSE_ONE／RECLAIM／SWEEP |
| `src/shared/operations.ts` | 55 | applyOperation／dedupeTransactions／replayBatch |
| `src/shared/microuac.ts` | 58 | 48-byte MicroUAC pack/unpack |
| `src/shared/config.ts` | 21 | 環境設定 |
| `src/shared/redis.ts` | 8 | ioredis 連線 |
| `src/shared/events.ts` | 25 | 領域事件發布 |
| `src/shared/health.ts` | 41 | 最小 HTTP server／`/health` |
| `src/services/batch-creator/index.ts` | 302 | REST、窗口歸集、輪詢、SSE、metrics |
| `src/services/batch-creator/dashboard.ts` | 127 | SSE 儀表板（僅顯示） |
| `src/services/batch-process/index.ts` | 342 | 可靠領取、OCC、去重、審計原子落庫 |
| `src/services/post-process/index.ts` | 45 | finalize 佇列 → Kafka stub／Finalized |
| `src/services/load-generator/index.ts` | 57 | 對照負載 CLI |
| `src/services/load-generator/runner.ts` | 95 | 對照負載 runner |
| `src/**` 合計 | **1403** | |

旁證（非 `src/**`，僅用來確認 schema 與既有測試意圖）：`db/init.sql`、`test/**`、`docker-compose.yml`、
`README.md`、`CONTEXT.md`、`docs/Payment Batching PoC Specs.md`。

**範圍限制**：本 repo 沒有任何身分驗證／授權／權限決策程式碼；`/health` 只回固定 200
（`src/shared/health.ts:12-15`），不是 readiness。因此「權限決策順序」在本工作項無對應實作可分析。

## 元件與狀態

### 對外入口

| 入口 | 行為 | 證據 |
| --- | --- | --- |
| `POST /accounts/:accountId/transactions`（`:3000`，`?mode=naive` 可選） | 驗證輸入 → 查結果快取 → 依模式入窗或直接入列 → 輪詢結果（≤5s）→ 回應 | `src/services/batch-creator/index.ts:265-297`、`168-246` |
| `GET /events`（SSE） | 訂閱 Redis `events` 頻道並轉發給瀏覽器 | `src/services/batch-creator/index.ts:29-61` |
| `GET /metrics` | 讀 `metrics:requests:*`／`metrics:dbwrites:*` 累計值 | `src/services/batch-creator/index.ts:248-263`；`src/shared/keys.ts:16-18` |
| `GET /`（儀表板）、`GET /health` | 靜態 HTML；固定 `{status:'ok'}` | `src/services/batch-creator/dashboard.ts:1-127`；`src/shared/health.ts:12-15` |
| worker／post-process 的 `/health`（`:3001`／`:3002`，僅供 compose healthcheck） | 同上，固定 200 | `src/services/batch-process/index.ts:28-29`；`src/services/post-process/index.ts:9-10` |

### 狀態變數

| 儲存 | 狀態 | 證據 |
| --- | --- | --- |
| Postgres `accounts` | `(id, balance BIGINT, version INTEGER)`；version 為 OCC 與批次版本 | `db/init.sql:4-8`；`src/services/batch-process/index.ts:116-125` |
| Postgres `processed_transactions` | `transaction_id` 全域 PRIMARY KEY、`account_id`、`applied_version`、`balance_after`；與餘額同交易寫入 | `db/init.sql:24-31`；`src/services/batch-process/index.ts:163-180` |
| Postgres `audit` | 每筆已套用交易一列，`micro_uac BYTEA`（48B）、`status` 只寫 `'Committed'` | `db/init.sql:11-22`；`src/services/batch-process/index.ts:182-192` |
| Redis `batch:{windowStart}:{accountId}` | 250ms 窗口內交易 list；`PEXPIRE windowMs+60000` | `src/shared/lua.ts:16-20`；`src/shared/keys.ts:7` |
| Redis `windows:active` | ZSET，member=bucket、score=關閉截止 `windowStart+250` | `src/shared/lua.ts:22`、`79` |
| Redis `tasks:global` | 全域任務佇列；一個非空窗口一個 Task | `src/shared/keys.ts:4`；`src/shared/lua.ts:43-46`、`91-94` |
| Redis `processing:{workerId}`、`worker:alive:{workerId}`、`workers` | 可靠佇列的 in-flight list、心跳鍵（TTL 10s）、worker 集合 | `src/shared/keys.ts:20-24`；`src/services/batch-process/index.ts:39-44`、`285-300` |
| Redis `result:{transactionId}` | 每 txid 的 `TaskResult`，TTL 30s | `src/shared/keys.ts:26-27`；`src/services/batch-process/index.ts:69-71` |
| Redis `finalize:queue` | 已提交 batch 的下游通知（每 batch 一則） | `src/shared/keys.ts:9-11`；`src/services/batch-process/index.ts:242-254` |
| Redis `events` pub/sub | 狀態機事件；publish 失敗會被吞掉 | `src/shared/keys.ts:13-14`；`src/shared/events.ts:19-24` |
| 程序內 | `sseClients`（SSE 連線）、`isSweeping`（避免 sweep 重疊） | `src/services/batch-creator/index.ts:29`、`83-94` |

### 關鍵流程

```
client ──POST──> creator
                  │ 1. 驗證 accountId / transactionId / operationType / amount（>0 整數）
                  │ 2. GET result:{txid} 命中 → 直接回 200（TTL 30s 內）
                  │ 3. batched：ACCUMULATE_LUA
                  │      Redis TIME → W = floor(now/250)*250
                  │      RPUSH batch:{W}:{acct}；首次建立 → ZADD windows:active W+250
                  │      isNew=1 → setTimeout(關閉 W+250)；另有每 100ms sweeper
                  │ 4. 每 10ms 輪詢 result:{txid}，最多 5s；逾時 504
                  ▼
             CLOSE_ONE_LUA / SWEEP_LUA（Redis 內原子）
                  LRANGE bucket → ZREM → DEL → 非空則組 Task → LPUSH tasks:global
                  → PUBLISH Queued
                  ▼
             batch-process（az-1/2/3）
                  BLMOVE tasks:global → processing:{worker}（至少一次）
                  ▼
             DB 交易（BEGIN … COMMIT）
                  SELECT account(balance,version)
                  SELECT processed_transactions WHERE transaction_id = ANY(batch txids)
                  dedupe（已套用 ∪ 批次內重複，保留首次）
                  replayBatch（依序套用；無餘額充足性檢查）
                  UPDATE accounts SET balance=?, version=version+1 WHERE id=? AND version=?
                    rowCount≠1 → ROLLBACK → 重試（≤20，jitter 5–25ms）
                  INSERT processed_transactions（ON CONFLICT(transaction_id) DO NOTHING）
                  INSERT audit（每筆一列 48B MicroUAC，status='Committed'）
                  COMMIT
                  ▼
             寫 result:{txid}（每個 unique txid）→ 若 didWrite：LPUSH finalize:queue
             → PUBLISH Committed → LREM processing:{worker}
                  ▼
             post-process：BRPOP finalize:queue → Kafka stub(log) → PUBLISH Finalized
```

證據：`src/services/batch-creator/index.ts:128-142`、`198-240`；`src/shared/lua.ts:9-53`、`74-102`；
`src/services/batch-process/index.ts:82-282`、`323-339`；`src/services/post-process/index.ts:32-43`。

### 實作特性（會影響建模，但不是規則本身）

- **無認證／授權**：accountId 來自 URL、transactionId 來自 body，任何呼叫者都可對任何帳戶送出交易
  （`src/services/batch-creator/index.ts:265-297`）。本工作項不建模權限。
- **naive 模式**：繞過窗口，每筆交易一個 Task（`taskId=txid`、`windowStart=-1`），不發
  `Accumulating`／`Queued` 事件（`src/services/batch-creator/index.ts:204-213`、`292`）。
- **`TentativeLogged` 是死狀態**：enum 有定義（`src/shared/types.ts:95`），但全 repo 沒有任何發射點；
  audit 只寫 `'Committed'`（`src/services/batch-process/index.ts:186`），schema 允許 `Tentative` 卻從未使用
  （`db/init.sql:19`）。
- **事件是 best-effort**：creator 的 `Ingested`／`Accumulating` 以 `void emitEvent(...)` 發出
  （`src/services/batch-creator/index.ts:191-196`、`224-230`），publish 失敗只記 log
  （`src/shared/events.ts:19-24`）；`Queued` 由 Lua 在 Redis 內發布（`src/shared/lua.ts:47-52`、`95-97`）。
- **健康檢查不是 readiness**：`/health` 不檢查 Redis／Postgres（`src/shared/health.ts:12-15`）。
- **計量是全域累計**：`requests` 在驗證通過後、快取查詢前就 `INCR`（`src/services/batch-creator/index.ts:188-190`），
  所以重複請求也算 requests；`dbWrites` 只在 `didWrite` 時 `INCR`（`src/services/batch-process/index.ts:217-222`）。
- **金額以 JS number 進出，DB 為 BIGINT**：讀取時 `Number(read.rows[0].balance)`
  （`src/services/batch-process/index.ts:124`），超過 2^53 會失去精度；`amount` 僅驗正整數、無上界
  （`src/services/batch-creator/index.ts:134`）。

## 候選規則

> 規則敘述以「程式實際行為」為準，不引用需求書的理想行為。`confirmed` = 有程式碼/schema 直接證據；
> `candidate` = 由行為推論出的性質，或程式未強制、需 G1 裁決的前提。

| ID | 規則 | 狀態 | 證據 |
| --- | --- | --- | --- |
| R-1 | **交易入口與輸入域**：只有 `POST /accounts/{accountId}/transactions` 產生交易；`accountId` 須匹配 `^[A-Za-z0-9_-]+$`；`transactionId` 為非空字串；`operationType ∈ {1,2,3,4}`；`amount` 為 >0 整數；body ≤1 MiB。輸入不合格 → 400（過大 → 413）；未知帳戶 → 404。 | confirmed | `src/services/batch-creator/index.ts:68,128-142,182-186,265-297`；`src/services/batch-process/index.ts:120-123,207-209` |
| R-2 | **窗口分派**：batched 請求由 `ACCUMULATE_LUA` 以 Redis TIME 決定 `W=floor(now/250)*250`，同一 `(account,W)` 的交易進同一 list `batch:{W}:{account}`；bucket TTL = 250ms + 60s。 | confirmed | `src/shared/lua.ts:9-25`；`src/shared/keys.ts:7` |
| R-3 | **關窗與入列**：第一個交易以 `setTimeout` 在 `W+250` 觸發 `CLOSE_ONE_LUA`；sweeper 每 100ms 關閉 `score ≤ now` 的窗口（單次上限 100）。兩者都在 Redis 內原子執行 `LRANGE`→`ZREM`→`DEL`，非空才組 Task 並 `LPUSH tasks:global`，同時 `PUBLISH Queued`；同一 bucket 至多被關一次。 | confirmed | `src/shared/lua.ts:30-53,74-102`；`src/services/batch-creator/index.ts:66-67,82-94,232-236,300-301` |
| R-4 | **佇列至少一次（at-least-once）**：worker 以 `BLMOVE tasks:global → processing:{worker}` 領取；處理完（成功或例外）以 `LREM` 移除；心跳每 3s、alive key TTL 10s；每 3s 掃 `workers`，對無 alive key 者用 `RECLAIM_LUA` 把其 processing 任務搬回全域佇列；啟動時先搬回自己的殘留。同一 Task 可被處理多次。 | confirmed | `src/services/batch-process/index.ts:39-44,285-300,302-339`；`src/shared/lua.ts:59-67`；`src/shared/keys.ts:20-24` |
| R-5 | **交易級冪等（同一 txid 至多一筆套用記錄）**：以 `processed_transactions.transaction_id`（全域 PRIMARY KEY）判定已套用；批次內重複保留首次出現；全部重複 → 提交 no-op；重試回傳歷史 `balance_after`／`applied_version`，不重新套用。 | confirmed | `src/services/batch-process/index.ts:96,127-150,226-239`；`src/shared/operations.ts:22-34`；`db/init.sql:24-31` |
| R-6 | **原子套用**：一個 DB 交易內依序完成「讀 account → 讀 processed → 去重／replay → OCC UPDATE → INSERT processed → INSERT audit(Committed) → COMMIT」；任何錯誤整批 ROLLBACK。不會出現「有餘額變更但無審計」。 | confirmed | `src/services/batch-process/index.ts:106-205` |
| R-7 | **OCC 與重試上限**：`UPDATE accounts SET balance=?, version=version+1 WHERE id=? AND version=?`；`rowCount ≠ 1` → ROLLBACK 並重試，最多 20 次（jitter 5–25ms）；耗盡 → 對該 Task 所有 txid 寫 `error:'conflict'`（HTTP 409）。 | confirmed | `src/services/batch-process/index.ts:36-37,99-103,155-161,211-213,276`；`src/services/batch-creator/index.ts:156-159` |
| R-8 | **版本與審計版本**：一次提交（≥1 筆新交易）使 version 恰好 +1；同一 batch 所有 audit 列的 `accountVersion` 都是 `version+1`；全重複的 no-op 不推進 version。 | confirmed | `src/services/batch-process/index.ts:145-158,184-195` |
| R-9 | **操作語義與重放**：`Credit` = `+amount`、`Debit` = `−amount`、`Authorize` = `−amount`、`Release` = `+amount`；未知 op 拋錯；batch 內依輸入順序（去重後）重放；**沒有**餘額充足性檢查、沒有部分成功機制。 | confirmed | `src/shared/operations.ts:5-18,41-55`；`src/shared/types.ts:4-9`；`src/services/batch-creator/index.ts:133` |
| R-10 | **MicroUAC 編碼與欄位來源**：48 bytes big-endian，佈局見檔頭；`transactionId` 欄位 = MD5(transactionId 字串) 前 8 bytes 轉 Int64；`referenceHash` = MD5(referenceId ?? transactionId)；`businessTime` = 使用者值 ?? 當下 Unix 秒；`sequenceNumber` = **去重後 applied 清單的 0-based index**（每批次從 0 起）；`accountVersion` = 該 batch 的提交版本。 | confirmed | `src/shared/microuac.ts:1-57`；`src/services/batch-process/index.ts:46-67,184-192` |
| R-11 | **結果快取與等待**：每個 unique txid 寫 `result:{txid}`（TTL 30s）；creator 先查快取、命中即回 200；未命中則每 10ms 輪詢、上限 5s，逾時 504。HTTP 狀態集：200／400／404／409／413／500／504。 | confirmed | `src/services/batch-creator/index.ts:63-65,144-166,198-202,239-240`；`src/services/batch-process/index.ts:69-71,224-240`；`src/shared/keys.ts:26-27` |
| R-12 | **下游 finalize 是 best-effort、at-most-once**：只有 `didWrite` 時 `LPUSH finalize:queue`；post-process 以 `BRPOP`（破壞性）取出，輸出 Kafka stub log 與 `Finalized` 事件；失敗只記 log，不影響餘額／審計。 | confirmed | `src/services/batch-process/index.ts:242-254`；`src/services/post-process/index.ts:12-43`；`src/shared/keys.ts:9-11` |
| R-13 | **狀態機事件集**：實際會發射 `Ingested`、`Accumulating`（僅 batched）、`Queued`（Lua 關窗）、`Processing`、`Committed`、`Finalized`；`TentativeLogged` 已定義但從未發射；事件 publish 失敗被吞掉。 | confirmed | `src/shared/types.ts:90-98`；`src/services/batch-creator/index.ts:191-196,224-230`；`src/shared/lua.ts:47-52,95-97`；`src/services/batch-process/index.ts:85-93,256-266`；`src/services/post-process/index.ts:22-29`；`src/shared/events.ts:7-24` |
| R-14 | **每 `(account, windowStart)` 至多一個 batch（條件式）**：正常情況下一個窗口只產生一個 Task；但 `CLOSE_ONE_LUA` 在 `DEL` 前**沒有重查 Redis TIME**（`src/shared/lua.ts:30-36`），關窗時機完全信任 creator 的 `setTimeout`（`src/services/batch-creator/index.ts:232-236`）。若 timer 相對 Redis 時鐘提前，bucket 會在 `W+250` 前被刪；之後落入同一 `W` 的新交易會建立新 bucket → 同窗第二個 batch。 | candidate | `src/shared/lua.ts:13-23,30-53`；`src/services/batch-creator/index.ts:232-236` |
| R-15 | **transactionId 全域唯一（程式未強制）**：result key 與 processed PK 都以 txid 為全域鍵，worker 只用 txid 查 `processed_transactions`，**不驗證 accountId／amount／operationType 是否與原交易一致**。跨帳戶重用同一 txid 時：第二個帳戶的 UPDATE 不與第一戶衝突（不同 row），但 processed `ON CONFLICT DO NOTHING` 只留第一戶的列 → 第二戶可能被實際套用卻沒有自己的 processed 記錄，且重試會拿到第一戶的歷史 balance/version。 | candidate | `src/services/batch-process/index.ts:96,127-143,163-180,224-239`；`src/services/batch-creator/index.ts:198-202`；`db/init.sql:24-26` |
| R-16 | **跨窗口提交順序不保證**：同一帳戶不同 `(W)` 的 Task 由不同 worker 並行處理；OCC 衝突加上 jitter 重試，可能讓較晚窗口先提交。只有「單一 batch 內依輸入順序重放」有保證，沒有 per-account 全序。 | candidate | `src/services/batch-process/index.ts:99-103,152-154,323-327`；`src/shared/operations.ts:44-55` |
| R-17 | **HTTP 結果狀態不等於「是否已套用」**：重複投遞時兩個 attempt 都會寫 `result:{txid}`（last-write-wins，TTL 30s）；重試耗盡的 attempt 會直接寫 `conflict`，可能覆蓋另一個 attempt 已寫入的成功結果；creator 的 5s 逾時（504）也不代表交易未提交。 | candidate | `src/services/batch-process/index.ts:224-240,276-281`；`src/services/batch-creator/index.ts:144-152,239-240`；`src/services/batch-process/index.ts:35` |
| R-18 | **SSE 事件順序不是不變量**：`Ingested`／`Accumulating` 是 fire-and-forget，`Queued` 由 Lua 與 worker 並行發出，因此觀察到的順序可能偏離名義狀態機（例如 `Queued` 早於 `Accumulating`，或 worker 的 `Committed` 早於 `Accumulating`）；dashboard 只保留每個帳戶的最後事件狀態。 | candidate | `src/services/batch-creator/index.ts:191-196,224-230`；`src/shared/lua.ts:47-52`；`src/shared/events.ts:7-24`；`src/services/batch-creator/dashboard.ts:86-100` |
| R-19 | **窗口資料耐久性有限**：未關閉的窗口只存在 Redis，`PEXPIRE 250ms+60s`；若 creator／sweeper 停機超過 TTL，bucket 會過期而不產生 Task，該窗口交易遺失（等待中的 client 只會得到 504）。ingress 沒有持久化或重放。 | candidate | `src/shared/lua.ts:20,74-102`；`src/services/batch-creator/index.ts:300-301` |
| R-20 | **Authorize／Release 沒有保留額度帳**：兩者直接對 balance 加減；沒有「Release 必須對應先前 Authorize」的檢查，也沒有「餘額不得為負」的下限；因此 balance 可為負，Conservation 仍成立。 | candidate | `src/shared/operations.ts:3-18,41-55`；`src/services/batch-creator/index.ts:133-134` |
| R-21 | **naive 模式是對照基準**：`?mode=naive` 時每筆交易自成一個 Task（`taskId=txid`、`windowStart=-1`），不經窗口、不發 `Accumulating`／`Queued`；worker／DB 套用路徑與 batched 相同。 | candidate | `src/services/batch-creator/index.ts:204-213,292`；`src/services/batch-process/index.ts:95`；`src/shared/types.ts:46,54` |

## 未確認問題

> 每題附**建議答案**；G1 只需確認或修正，不需重新推導。這些問題也是 `report.json` 的 `openQuestions`。

**Q1（R-14，owner 提示 2）提前關窗要不要建模成可達狀態？**
程式在 `CLOSE_ONE_LUA` 刪 bucket 前沒有重查 Redis TIME，關窗時機完全由 creator 的 `setTimeout` 決定。
在單機同一時鐘下 timer 不會提前，但 owner 提示要求把「早關」視為未證實風險、不要用環境假設直接排除。
**建議答案**：建模為可達事件（early-close），不預設排除；RULES 寫成條件式「若無提前關窗，則每個
`(account, windowStart)` 恰一個 batch」。若 G1 判定提前關窗屬實作缺陷，則列 candidate finding 交後續階段回放，
**不在 grill 階段修程式**。

**Q2（R-15）transactionId 的唯一性範圍是全域還是 per-account？**
程式把 txid 當全域鍵（result key、processed PK），但沒有驗證 account／amount；跨帳戶重用會造成第二戶
「已套用但無 processed 記錄」、重試回傳第一戶的歷史結果。
**建議答案**：把「txid 全域唯一，且同一 txid 的 account/op/amount 固定」列為**上游前提（precondition）**；
模型不模擬跨帳戶重用；同時在報告把「程式未強制此前提」列為 candidate 風險。若 G1 認為前提不成立，
則 R-5／R-6 有反例，需另開修復工作項。

**Q3（R-16）是否需要 per-account 跨窗口的全序（Account Affinity）？**
程式只保證 batch 內順序；不同窗口可能由不同 worker 並行提交，OCC 重試可讓後窗先落地。
**建議答案**：不要求全序。RULES 只要求「batch 內依輸入順序」＋「最終 balance／version 單調」＋「每 txid 至多一次」。
若 G1 要求嚴格全序，現況就是 candidate 缺陷（不是模型可以補掉的）。

**Q4（R-17）504／409 要如何寫進規則？**
creator 5s 逾時回 504，但交易可能稍後才提交；重複投遞時 error 結果可能覆蓋成功結果（TTL 內 last-write-wins）。
**建議答案**：規則寫「504 代表結果未知，客戶端必須以同一 txid 重試」；「409 不保證未套用」列 candidate
finding。模型把「兩個 attempt 都寫結果」抽象成結果不確定，或以 last-write-wins 建模；不要假設 HTTP 狀態
等於 DB 最終狀態。

**Q5（R-18）SSE 狀態機順序是否要列為不變量？**
`Ingested`／`Accumulating` 是 fire-and-forget，`Queued` 由 Lua 與 worker 並行發布。
**建議答案**：不列。事件流只供儀表板顯示；模型只建內部狀態（bucket／queue／DB），不建 SSE 送達順序。
若 G1 要順序保證，需先改程式（本階段不做）。

**Q6（R-19）creator 停機造成的窗口遺失算不算範圍內？**
未關閉窗口只在 Redis 且 60s 過期；停機超過 TTL 後交易無聲消失，client 只看到 504。
**建議答案**：列為環境失敗（ENV）並在 RULES 註明「窗口資料可能遺失」；或由 G1 明確寫 out-of-scope。
不建議默默假設零遺失。

**Q7（R-20）Authorize／Release 與負餘額的規則？**
程式直接加減、無保留額度帳、無 Release 對應檢查、無餘額下限。
**建議答案**：照程式建模（可負餘額、Release 可獨立出現），只保留 Conservation（R-2）。
若業務要求「餘額不得為負」或「Release 必須有對應 Authorize」，現況必違反，需另開修復，不寫進 as-is 規則。

**Q8（R-21）naive 模式是否納入核心模型？**
naive 是每筆一 Task 的對照基準，共用 worker／DB 路徑，但跳過窗口與兩個事件。
**建議答案**：核心模型排除 naive；若需要，另建獨立小模型或只在 ENV 註記。RULES 明確寫「核心模型只涵蓋 batched」。

**Q9（R-10，owner 提示 3）audit sequenceNumber 的語義？**
程式用「去重後 applied 清單」的 0-based index，而非原始 batch 位置；每批次從 0 重新起算。
**建議答案**：RULES 照程式寫「sequenceNumber = applied 清單 0-based index，每批次從 0 起；
`(accountVersion, sequenceNumber)` 在同帳戶內唯一」。若 G1 要求原始 batch 位置或 1-based，現況需改程式
（不在本階段），並列 candidate 差異。

**Q10（R-13）`TentativeLogged` 要不要進狀態機？**
enum 有，但沒有任何發射點；audit 只寫 `Committed`。
**建議答案**：as-is 模型不含 `TentativeLogged`；狀態集只到 `Committed`，`Finalized` 為可缺的 best-effort。
把「Tentative 是規格概念、程式未實作」記為 candidate 差異，供後續階段決定是否補。

**Q11（R-10）referenceId 是否參與冪等？**
`types.ts:17` 註解說 referenceId「用於冪等」，但實作只把 txid 當冪等鍵，referenceId 只進 audit 的 MD5。
**建議答案**：冪等鍵只有 transactionId；referenceId 僅作審計 fingerprint。註解與實作不符列為文件待修正
（本階段不改 docs）。

**Q12（R-1／R-10）amount／businessTime 的模型數值域？**
程式只驗 `amount` 為正整數、無上界；`businessTime` 未驗證。超出 MicroUAC 欄位範圍（Int64／UInt32）時
`packMicroUAC` 會丟例外，整個 DB 交易 rollback，client 得到 500。
**建議答案**：amount 取「正整數」，具體上限在下一階段以 `domain_justification` 決定（至少涵蓋 1 與邊界值，
不得只用程式沒有的假設縮小）；businessTime 取 `0..2^32−1`、未提供時為當下秒。超界視為 invalid／500，
不列入正常套用。

**Q13（R-1／R-5，owner 提示 1）要不要建兩個可交錯的 attempt？**
owner 要求以 attempt id 建模「同一 batch 被兩個 worker 同時處理」與崩潰後重認領，不要假設同一 batch 只有一個 in-flight。
**建議答案**：是。建 A／B 兩個 attempt 與 reclaim 事件，容許任意交錯；重點檢查 R-1（INV-4）與 R-2（INV-1）。
在同一帳戶下，OCC 的 `UPDATE ... WHERE version=?` 在 READ COMMITTED 會重評條件，加上 processed PK，
重複套用應被阻擋；跨帳戶重用則不成立（見 Q2）。

**Q14（R-4／R-6）審計完整性要列為哪一條規則？**
程式在同一 DB 交易寫入餘額、processed 與 audit，正常情況下每筆 applied 交易恰一筆 audit。
**建議答案**：列為不變量「對每個 account，audit 列數 = 該帳戶已套用的 transaction 數；不存在有餘額變更而無
audit 的狀態」。但 Q2 的跨帳戶 txid 重用會破壞這個等式，需先確認前提。

**Q15 部署假設：單一 creator、單一 Redis、單一 Postgres？**
compose 只有一個 `batch-creator`（`docker-compose.yml`），但有 3 個 worker；程式的窗口 timer 依賴「單一 creator」。
**建議答案**：模型假設單一 creator（sweeper／timer 只有一組）＋單一 Redis＋單一 Postgres（READ COMMITTED）；
多 creator 競爭不在 as-is 模型。若 G1 要涵蓋多 creator，需先確認 timer／sweeper 的重複關窗行為是否仍安全。

## RULES.md 草稿

> **候選版本，僅供 G1 確認，不是已確認規則，不得直接用於建模或驗證。** 每條規則的程式證據見上一節；
> `confirmed` 代表程式碼直接支持，`candidate` 代表需 G1 裁決的推論或前提。

### 全域前提

- **P-1**（candidate）：單一 `batch-creator`、單一 Redis、單一 Postgres；Postgres 為 READ COMMITTED。
- **P-2**（candidate）：`transactionId` 由上游保證全域唯一，且同一 txid 的 account／op／amount 固定不變。
- **P-3**（candidate）：客戶端在 504／網路錯誤後會以同一 txid 重試；重試可能與原請求並行。
- **P-4**（candidate）：金額為最小貨幣單位整數；`amount ≥ 1`；模型常數域於下一階段以 `domain_justification` 定義。

### 已確認（依程式碼）

- **R-1**（confirmed）同一 `transactionId` 至多有一筆 `processed_transactions` 套用記錄；重複投遞／重認領
  只回傳歷史 `(balance_after, applied_version)`，不重複改變餘額。
- **R-2**（confirmed）守恆：對每個 account，`balance = 初始 balance + Σ(signedAmount)`，其中
  Credit／Release 為 `+amount`、Debit／Authorize 為 `−amount`；只計已套用的交易。
- **R-3**（confirmed）批次原子性：一個 batch 的所有新交易要麼全部套用（餘額變更＋processed＋audit 同交易
  提交），要麼全部不套用（ROLLBACK）。
- **R-4**（confirmed）審計完整：每筆成功套用的交易恰有一筆 48-byte MicroUAC，`status='Committed'`，與餘額
  同一 DB 交易提交；不存在「有餘額變更而無審計」的狀態。
- **R-5**（confirmed）版本：一次成功提交（≥1 筆新交易）使 `version` 恰好 +1；同 batch 所有 audit 列的
  `accountVersion` 為該提交版本；全重複的 no-op 不推進版本。
- **R-6**（confirmed）佇列語義為 at-least-once：Task 以 `BLMOVE` 移入 worker 的 processing list，崩潰後可被
  其他 worker 重認領；同一 Task 可能被處理多次，最終效果由 R-1／R-3／R-4 約束。
- **R-7**（confirmed）窗口：batched 交易以 Redis TIME 分為 250ms 窗；同一 `(account, window)` 的交易歸集為
  一個 bucket；非空 bucket 關閉時產生恰好一個 Task；`setTimeout` 為主要關窗、sweeper 每 100ms 補漏。
- **R-8**（confirmed）輸入域：`accountId` 匹配 `^[A-Za-z0-9_-]+$`；`transactionId` 非空；`operationType ∈ {1,2,3,4}`；
  `amount` 為 >0 整數；body ≤1 MiB；不合格 → 400，未知帳戶 → 404。
- **R-9**（confirmed）操作語義：Credit／Debit／Authorize／Release 直接對 balance 加減；batch 內依輸入順序
  （去重後）重放；無餘額充足性檢查、無部分成功。
- **R-10**（confirmed）MicroUAC：固定 48 bytes；txid 欄位為 MD5 前 8 bytes（Int64）；referenceHash 為
  MD5(referenceId ?? txid)；businessTime 預設當下秒；sequenceNumber 為 applied 清單 0-based index；
  accountVersion 為批次提交版本。
- **R-11**（confirmed）OCC：以讀到的 version 做條件更新；失敗重試 ≤20 次、jitter 5–25ms；耗盡回 409
  （該 attempt 未提交）；未知帳戶回 404。
- **R-12**（confirmed）回應：每個 unique txid 寫 TTL 30s 的結果快取；creator 先查快取，否則輪詢 ≤5s，
  逾時 504；成功回 `{accountId, balance, version}`。
- **R-13**（confirmed）下游 finalize 僅為 best-effort：`finalize:queue` 以破壞性 `BRPOP` 消費，
  只產生 Kafka stub log 與 `Finalized` 事件；遺失不影響餘額／審計。
- **R-14**（confirmed）狀態集：`Ingested`／`Accumulating`／`Queued`／`Processing`／`Committed`／`Finalized`
  會被發射；`TentativeLogged` 已定義但從未發射。

### 待 G1 確認（candidate）

- **R-15**（candidate）每個 `(account, windowStart)` 至多一個 batch；此性質依賴「關窗不早於 `W+250`」。
  `CLOSE_ONE_LUA` 不重查 Redis TIME，若 timer 提前，同一窗口可產生第二個 batch。
- **R-16**（candidate）`transactionId` 全域唯一，且 payload 固定；程式未強制，跨帳戶重用會破壞 R-1／R-4。
- **R-17**（candidate）不保證 per-account 跨窗口提交順序；只保證 batch 內順序與最終餘額。
- **R-18**（candidate）HTTP 504／409 不代表交易未套用；重複 attempt 的結果可能互相覆寫（last-write-wins）。
- **R-19**（candidate）SSE 事件順序與狀態機順序不是不變量；事件只供顯示。
- **R-20**（candidate）未關閉窗口只存在 Redis（60s TTL）；creator 停機超過 TTL 會造成該窗口交易遺失。
- **R-21**（candidate）Authorize／Release 沒有保留額度帳、沒有 Release 對應檢查、可負餘額。
- **R-22**（candidate）naive 模式每筆一 Task、跳過窗口與 `Accumulating`／`Queued`，不屬核心模型。

### 明確不在本模型範圍

- 身分驗證／授權／權限決策（程式完全沒有）。
- Redis 全盤故障的直連降級、影子雙寫、流量放大壓測（文件宣告為 PoC 範圍外）。
- HTTP 連線層行為（keep-alive、SSE 重連、body 過大時 socket 被 destroy 的回應細節）。
