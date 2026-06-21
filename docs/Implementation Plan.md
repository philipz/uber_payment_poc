# 實作計劃 — Payment Batching PoC

依據 `docs/Payment Batching PoC Specs.md` 與 `docs/adr/0001-single-server-nodejs-poc.md`。
每個 Phase 是一個可獨立認領的垂直切片（tracer-bullet），都有明確的驗收條件。

## 技術棧 / 架構基線

- Node.js (TypeScript)，Docker Compose 多容器：`redis`、`postgres`、`batch-creator`、`batch-process`（×3，AZ 識別碼 az-1/2/3）、`post-process`、`load-generator`。
- 前端 → Creator：HTTP REST。後端協調：全經 Redis（任務佇列、results cache）+ Postgres。
- 金額：整數最小單位（分），Int64。

---

## Phase 0 — 專案骨架與 Compose 骨幹

**目標**：可一鍵拉起所有容器並通過健康檢查。

- TypeScript 專案結構、共用型別（Transaction、Batch、AccountState）、lint/build。
- `docker-compose.yml`：redis、postgres（含初始 schema：`accounts(id, balance, version)`、`audit` 表）、各服務空殼。
- 各服務 `/health` endpoint。
- 驗收：`docker compose up` 後所有容器 healthy；`accounts` 表有一個種子熱點賬戶。

## Phase 1 — 最薄端到端切片（tracer bullet）

**目標**：單筆請求走完全程，證明管線打通（先不做窗口聚合、單一 worker）。

- batch-creator：`POST /accounts/:id/transactions`，寫入 Redis 全域佇列，輪詢 results cache（10ms）後回應。
- batch-process（1 個）：領取任務 → 讀 Postgres → 算新餘額 → `UPDATE ... WHERE version=?` → 寫 results cache。
- 驗收：curl 單筆請求得到正確新餘額；Postgres version +1。

## Phase 2 — 250ms 窗口聚合

**目標**：同一賬戶短時間多筆 → 歸集為一個 batch → 單次 DB 讀寫。

- Lua 腳本：以 Redis TIME 權威時鐘將請求分配至 250ms 窗口 bucket。
- 每窗口 `setTimeout(250ms)` 關閉 → close-Lua 原子打包 batch 推入全域佇列並標 Queued；低頻 sweeper 兜底。
- batch-process：對一個 batch 做單次讀 → 記憶體依序重放 → 單次寫入。
- 驗收：對單一賬戶在 250ms 內灌 N 筆，log 顯示「N 筆 → 1 次 DB 讀 + 1 次 DB 寫」；最終餘額正確。

## Phase 3 — 多 worker 競爭 + Exactly-Once

**目標**：3 個 AZ worker 搶同一佇列，樂觀鎖保證剛好一次提交。

- batch-process 擴成 3 容器，各帶 AZ 識別碼（Executor Identifier）。
- OCC 衝突 → 放棄本次、重讀主庫、重試。
- 驗收：log 看得見不同 AZ 領取任務與 OCC 衝突重試；「最終 version == 成功提交的 batch 數」；無重複計帳。

## Phase 4 — MicroUAC 48-byte 二進位 + 最小化後處理

**目標**：忠實緊湊審計結構落庫。

- MicroUAC 打包/解包（Buffer，48 bytes：TransactionID/OperationType/Amount/SequenceNumber/AccountVersion/ReferenceHash/BusinessTime/Reserved）。
- post-process：從 Redis 非同步消費，將 MicroUAC（hex）寫入 audit 表；Kafka 以 stdout/檔案 stub。
- 驗收：audit 表每筆審計為 48-byte hex，可解碼回欄位並與交易吻合。

## Phase 5 — 狀態機事件流 + SSE Web 儀表板

**目標**：把端到端流程演給人看。

- 結構化事件為單一事實來源（同時餵 log 與 SSE）。
- batch-creator 提供 SSE endpoint；一頁 HTML 即時顯示每筆交易狀態機流轉（Ingested→…→Finalized）、餘額、版本、哪個 AZ worker 搶到。
- 驗收：瀏覽器開儀表板，灌負載時即時看到狀態流轉與 worker 競爭。

## Phase 6 — 對照組 Load Generator（批次 vs 天真單筆）

**目標**：把 spec 的攤薄數學模型變成看得見的數字。

- load-generator：對單一熱點賬戶射出可設定並發/持續時間。
- 天真模式：同 endpoint 加 `mode=naive`，每請求一次直連讀-改-寫（OCC/row lock）。
- 儀表板兩欄並排：批次 vs 天真的「請求數 / DB 寫入數」壓縮比、等效延遲、最終餘額一致性。
- 驗收：並排對照清楚顯示批次模式的壓縮比與攤薄優勢；兩模式最終餘額一致。

---

## 明確不在範圍（見 ADR 0001）

Redis 崩潰降級、Tentative/Committed 完整審計轉檔、影子雙寫校驗服務、10–15x 流量放大壓測、真實 Multi-AZ 跨區容錯、嚴格 benchmark。
