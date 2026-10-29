# RULES.md — philipz/uber_payment_poc（G1 確認版 v2）

- 確認者：philipz（GitHub user id 664465，白名單）
- 確認日期：2026-10-29
- 驗證基準：`main` @ `672fc88945e7923cb392530a852c38e508f54f21`
- 範圍：`src/**`（Issue #69）
- 用途：Quint 模型（②）→ Lean 證明（③）→ 反例測試（④）的唯一規則來源

## G1 決定（15 個問題）

| # | 問題 | 決定 |
|---|---|---|
| Q1 | 提前關窗（R-14） | **建立為可達事件**：`CLOSE_ONE_LUA` 刪 bucket 前不重查 Redis TIME，timer 可能相對 Redis 時鐘提前 → 模型必須允許 early-close，不得用環境假設排除 |
| Q2 | txid 唯一性範圍 | **全域唯一 + payload 固定**列為上游前提；模型不模擬跨帳戶重用（實作副作用記為 candidate 差異） |
| Q3 | per-account 跨窗全序 | **不要求**：只要求 batch 內順序、最終 balance 正確、version 單調 |
| Q4 | 504／409 語義 | 504 = 結果未知，客戶端以同 txid 重試；「409 不保證未套用」列 candidate finding |
| Q5 | SSE 順序 | **不列不變量**：事件流僅供顯示 |
| Q6 | 窗口資料耐久性 | 列為環境失敗（ENV-5）：未關窗資料只在 Redis，可能遺失 |
| Q7 | Authorize／Release／負餘額 | 照程式：可負餘額、Release 可獨立出現、只保留守恆規則 |
| Q8 | naive 模式 | **核心模型只涵蓋 batched**；naive 排除 |
| Q9 | audit sequenceNumber | 照程式：`applied` 清單 0-based index，每批次從 0 起 |
| Q10 | TentativeLogged | as-is 模型不含：狀態集只到 `Committed`；「規格有、程式未實作」記 candidate 差異 |
| Q11 | referenceId | 冪等鍵只有 `transactionId`；`referenceId` 僅 audit fingerprint |
| Q12 | amount 數值域 | 正整數、無程式上界；模型的具體上限留待第二階段 domain_justification |
| Q13 | 兩個可交錯 attempt | **是**：以 attempt id 建 A／B 與 reclaim 事件，容許任意交錯；不得假設「同一 batch 只有一個 in-flight」；重點檢查 INV-4／INV-1 |
| Q14 | 審計完整性 | **列為不變量**（INV-9）：每筆已套用交易恰一筆 audit，不存在有餘額變更而無 audit 的狀態 |
| Q15 | 部署假設 | 單一 creator、單一 Redis、單一 Postgres（READ COMMITTED）；多 creator 不在 as-is 模型 |

## 環境假設

- **ENV-1** `transactionId` 全域唯一且 payload 固定（上游前提）。
- **ENV-2** Redis TIME 是權威時鐘且單調；但 **creator 的 timer 可能相對它提前**（Q1／Q6）。
- **ENV-3（at-least-once，含併發）** 同一 task 可被重複投遞，且**可能同時被兩個 worker 處理**（崩潰後重認領）。模型以 attempt id 建模，兩個 attempt 可任意交錯。
- **ENV-4** finalize 通知與領域事件 best-effort：可遺失、可重複、可亂序。
- **ENV-5** 未關閉窗口的資料只在 Redis（PEXPIRE 250ms+60s）；creator／sweeper 停機超過 TTL 會使該窗口交易遺失。

## 安全不變量（要證明／要否證）

- **INV-1** 每 account：`balance = initial_balance + Σ signed(amount)`，只涵蓋已套用交易。
- **INV-2** 每 account：`count(audit) = count(processed_transactions) = 已套用交易數`。
- **INV-3** `accounts.version` = 非 no-op 提交次數；每次 +1、單調遞增。
- **INV-4** 每個 `transactionId` 最多被套用一次（重複投遞、重試、快取失效後重送皆不變）。
- **INV-5** batch 原子性：新交易、processed 列、audit 列全提交或全不提交。
- **INV-6** 每筆已套用交易恰一筆 48-byte audit，`status='Committed'`，operation／amount 一致，`accountVersion` = 該次提交後版本。
- **INV-7** no-op 批次（全部重複）不改變 balance／version／audit，也不產生 finalize。
- **INV-8** 每個 `(accountId, windowStart)` **最多只有一個 batch／task**（Q1：early-close 可達時這條會被檢驗）。
- **INV-9（Q14）** 不存在「有餘額變更而無對應 audit」的狀態。

## 行為規則

- **ACT-1** `windowStart = floor(RedisTimeMs / 250) * 250`；同 account 同窗交易歸同一 bucket。
- **ACT-2** 窗口關閉：原子取出／刪除 bucket；空窗 no-op；非空窗恰一 task + 一 `Queued`。
- **ACT-3** 批次重放：依 batch 內到達序逐筆套用，回傳最終與每步餘額；無部分成功。
- **ACT-4** OCC 提交：`UPDATE ... WHERE version = v`；0 列受影響 → ROLLBACK 重試（最多 20 次）；成功則 version = v+1。
- **ACT-5** 批次內重放順序 = 到達序。
- **ACT-6** 錯誤回應不宣稱未套用；只有 200 是已套用的權威聲明；重試必須安全。
- **ACT-7（Q1）** 關窗有兩條路徑：deadline 檢查看 Redis TIME；**timer 路徑不重查**。模型必須把 timer 提前觸發建成可達事件。
- **ACT-8（Q13）** 同一 batch 的兩個 attempt 可交錯：讀取→去重→OCC 寫入→記錄 processed／audit 全在同一個 DB 交易內；交錯時哪個 attempt 先提交由排程決定。

## 明確不驗證（as-is 模型範圍外）

- OUT-1 餘額充足性／不得透支；OUT-2 Tentative→Committed 兩階段審計；OUT-3 `referenceId` 參與冪等；OUT-4 Finalized liveness；OUT-5 複式記帳／跨帳戶守恆；OUT-6 metrics；OUT-7 跨批次嚴格 `windowStart` 全序；OUT-8 批次內依 `businessTime` 升序；OUT-9 SSE 事件送達順序；OUT-10 naive 模式；OUT-11 多 creator 競爭；OUT-12 跨帳戶重用同一 txid（列為上游前提）。
