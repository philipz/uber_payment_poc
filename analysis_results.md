# Uber Payment Batching PoC 分析與評估報告

本報告針對專案執行情況進行評估，重點分析系統中存在的數據不一致與數據遺失風險，並將現有實作與 `docs/Payment Batching PoC Specs.md` 需求書進行對比。

---

## 一、 專案執行與驗證狀態

我們已依照 `README.md` 的指示在本地環境中執行了該專案，主要步驟如下：
1. **啟動容器服務**：執行 `docker compose up -d --build` 成功建置並啟動了所有 7 個容器（`postgres`, `redis`, `batch-creator`, `batch-process-az1/2/3`, `post-process`），且健康檢查（healthcheck）均顯示為 `healthy`。
2. **單元測試驗證**：執行 `npm run test:unit`，所有 15 個單元測試均順利通過（涵蓋邏輯重放、MicroUAC 編解碼等功能）。
3. **端到端測試驗證**：執行 `npm run test:e2e`，所有 12 個 E2E 測試全數通過（驗證了單筆交易、並發歸集、樂觀鎖 Exactly-Once、SSE 狀態機以及對照組壓縮比等功能）。

---

## 二、 數據不一致與數據遺失風險分析

在詳細審查原始碼後，我們發現系統在極端並發、系統崩潰或網路異常時，存在以下嚴重的**數據不一致（Data Inconsistency）**與**數據遺失（Data Loss）**風險：

### 1. 同一交易 ID 並發請求的冪等失效（導致重複記帳 / 數據不一致）
* **問題描述**：`batch-creator` 在接收交易時，雖然會先檢查 Redis 快取（`resultKey(txn.transactionId)`）以進行基本冪等防護，但在並發場景下，當**同一個 `transactionId` 的多個重複請求同時到達時**，此時 Redis 中尚未寫入計算結果，兩筆請求都會通過快取檢查，並在 `ACCUMULATE_LUA` 中被重複推入同一個 Redis 窗口 bucket 中。
* **後續影響**：同一個 `transactionId` 在記憶體中被重放（`replayBatch`）兩次，Postgres 中的帳戶餘額會被重複扣減/加款（Double charging/crediting），並且會生成兩筆具備相同 `transactionId` 但序號（`sequenceNumber`）不同的 `micro_uac` 審計記錄，導致嚴重數據不一致。
* **實機驗證**：我們編寫了並發測試腳本 `scratch/concurrency_test.js` 進行驗證，初始化餘額 1000，同時對同一個交易 ID 發送兩筆並發 Credit 100 的請求，**最終餘額變成了 1200（而非冪等的 1100）**，且 Postgres 審計表中出現了兩條相同交易 ID 的記錄，證實了此漏洞的存在。

### 2. 缺失「暫存審計（Tentative Logged）」寫入階段（導致懸空狀態 / 審計數據遺失）
* **問題描述**：需求書要求在變更正式落庫前，必須先將審計日誌以 `Tentative` 狀態寫入，成功落庫後再標記為 `Committed`，以防止「雙寫（Dual-write）不一致」。然而在當前代碼中：
  - `batch-process` 直接更新 Postgres 的 `accounts` 表（樂觀鎖落庫）。
  - 更新成功後，才非同步地將審計任務發送至 Redis 的 `AUDIT_QUEUE`（由 `post-process` 非同步寫入 `audit` 表且狀態直接為 `Committed`）。
* **後續影響**：如果工作節點（Worker）在更新 Postgres 成功後、將審計任務推入 `AUDIT_QUEUE` 之前發生**當機或重啟**，則帳戶餘額已在資料庫中被永久變更，但其對應的審計記錄（Audit Log）將**永久丟失**，這造成了需求書中所禁止的「懸空狀態」（帳戶餘額變更但沒有審計日誌）。

### 3. BRPOP 破壞性讀取且缺乏重試機制（導致任務 / 審計數據遺失）
* **問題描述**：
  - **任務隊列**：`batch-process` 使用 `BRPOP` 從 `tasks:global` 領取任務。`BRPOP` 會直接將任務從 Redis 隊列中刪除。如果 Worker 在處理該 batch 任務的過程中崩潰，該 batch 的所有交易任務將**永久丟失**，不會有其他 Worker 重新認領。
  - **審計隊列**：`post-process` 同樣使用 `BRPOP` 從 `tasks:audit` 領取審計任務。若 `persist` 寫入資料庫失敗（例如 Postgres 暫時斷線），該審計日誌將被丟棄並**永久丟失**（At-most-once 語義）。
* **改善建議**：生產環境應改用 `BLMOVE` 將任務移至進程中的處理隊列（Processing Queue），並在成功確認後再刪除，配合逾時未確認的重啟認領機制，確保 Exactly-Once 與數據零丟失。

---

## 三、 與需求書（Specs）的詳細比對

以下是本 PoC 現有實作與 `Payment Batching PoC Specs.md` 的逐項對照表：

| 需求項目 | 需求書 Specs 規範 | 現有 PoC 實作情況 | 是否符合 | 差異與缺失分析 |
| :--- | :--- | :--- | :--- | :--- |
| **時間窗口聚合** | 250ms 窗口，N 筆請求 -> 1 次 DB 讀寫 | 透過 Redis Lua 腳本進行時間歸集與 setTimeout 關閉窗口 | **符合** | 核心批次歸集機制完整實作。 |
| **分散式時鐘同步** | 以主控帳戶分片的 Redis TIME 作為權威時間源 | Lua 腳本內調用 `redis.call('TIME')` 計算 windowStart | **符合** | 解決了多節點時鐘漂移的問題。 |
| **MicroUAC 結構** | 每筆審計限制 48 位元組，二進位格式儲存 | `src/shared/microuac.ts` 精確定義 48-byte 二進位 pack/unpack | **符合** | 滿足緊湊二進位儲存要求。 |
| **Exactly-Once 提交** | 樂觀鎖（OCC）原子寫入，版本號冲突重試 | `UPDATE accounts SET balance = ?, version = version + 1 WHERE id = ? AND version = ?` | **部分符合** | OCC 僅能防範並發寫入衝突，由於**缺乏資料庫端的交易 ID 去重（Deduplication）**，無法防範重複請求和 cache 失效時的重放。 |
| **任務認領與安全機制** | 設置任務 TTL，超時未認領則觸發警報並重新入隊 | 直接使用 `BRPOP` 彈出任務，無任務鎖、無 TTL 偵測與重跑機制 | **不符合** | 當 Worker 在處理中崩庫時，任務會永久遺失，無法達成多可用區無縫接管的容錯。 |
| **暫存審計狀態流轉** | 餘額更新前寫入 `Tentative`，成功後改為 `Committed` | 略過 `Tentative` 狀態，落庫成功後才非同步推入隊列，直接寫入 `Committed` | **不符合** | 存在「雙寫不一致」風險，可能導致帳戶有變更但無審計軌跡的「懸空狀態」。 |
| **緩存崩潰降級預案** | Redis 癱瘓時，自動降級直連底層主庫（如 Docstore） | Creator 呼叫 Lua 報錯時直接回傳 500 錯誤，無任何降級直連機制 | **不符合** | 缺乏 Redis 斷開時的自動降級容災預案。 |
| **影子雙寫測試** | 部署平行影子系統比對餘額與軌跡，要求 100% 一致 | 程式碼中完全沒有影子系統與校驗服務的實作 | **出範圍** | `README.md` 已註明影子測試非本 PoC 驗證範圍。 |
| **流量放大壓測** | 10x-15x 流量回放，測試 Redis 與主庫瓶頸 | 僅有 `load-generator` 對照測試，無生產流量放大回放工具 | **出範圍** | `README.md` 已註明流量放大壓測非本 PoC 驗證範圍。 |

---

## 四、 總結與改進建議

本 PoC 專案非常成功地驗證了 **「250ms 時間窗口聚合壓制資料庫寫入放大」** 的核心架構可行性（E2E 測試中展示了顯著的壓縮比與正確的餘額重放）。

然而，若要將此架構推向生產環境，必須解決上述的**數據一致性與安全性漏洞**：
1. **數據庫端去重**：在 Postgres 中維護一個已處理的 `transaction_id` 記錄表，或者在 `accounts` 表中記錄最近應用的交易 ID，落庫時在同一個事務中進行排他校驗，確保在快取失效或並發繞過時仍能保證 Exactly-Once。
2. **引入可靠隊列模式**：將 Redis 的 `LPUSH/BRPOP` 升級為 `LMOVE/BLMOVE` 模式（使用雙佇列防護），為任務和審計隊列提供重試與崩潰恢復能力，消除 At-most-once 帶來的數據丟失風險。
3. **實作真正的 Tentative Log**：嚴格遵循設計需求書，在更新餘額前，於同一事務（或具備關聯的分布式事務中）先寫入 `Tentative` 審計記錄，落庫成功後才更新為 `Committed`。
