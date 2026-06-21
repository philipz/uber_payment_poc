# CONTEXT

本專案的領域語言詞彙表（glossary）。只記錄「概念」，不記錄實作細節或決策理由。
實作決策見 `docs/adr/`。

## 詞彙

### Account（賬戶）
金融複式記帳模型中，餘額會被變更的記帳實體。每個 Account 有一個目前餘額與一個版本號（Version）。

### Hot Account（熱點賬戶）
在極短時間內遭遇大量並發寫入競爭的單一 Account（如大型商戶清算、系統性對賬調整）。本系統存在的唯一理由就是處理 Hot Account。

### Time Window（時間窗口）
一段固定長度（250ms）的時間區間。落在同一個 Account、同一個 Time Window 內的多筆變更請求會被歸集為一個 Batch。窗口邊界由權威時間源裁定，不由各節點本地時鐘裁定。

### Batch（批次）
同一 Account 在同一 Time Window 內所有變更請求的集合。Batch 是被排隊、被領取、被原子提交的最小單位。

### Account Affinity（賬戶親和性）
「同一個 Account 的請求必須被歸集到一起、並嚴格依序處理」這個約束。

### Account Version（賬戶版本）
Account 上的單調遞增整數。每次成功提交一個 Batch，Version 推進一次。用於樂觀並發控制與對賬回溯。

### Optimistic Concurrency Control（樂觀並發控制 / 樂觀鎖）
提交時以「目前讀到的 Version」為條件寫回；若 Account 的 Version 已被他人推進，本次寫入失敗並重試。這是達成 Exactly-Once 的手段。

### Exactly-Once（剛好一次處理）
即使同一個 Batch 任務被重複派發給多個處理節點，最終也只有一個節點能成功提交、且只提交一次。

### Executor Identifier（執行器識別碼）
處理節點啟動時登記的身分標記（spec 中以其所在的可用區 AZ 名稱為值），用於辨識是哪個節點領取/提交了 Batch。

### MicroUAC（緊湊用戶賬戶變更記錄）
每筆子交易的精簡變更歷史記錄，限制在極小位元組數內（spec 設計為 48 bytes），只保留冪等校驗與對賬所需的核心元數據。

### UAC（用戶賬戶變更歷史）
標準的、完整的賬戶變更歷史記錄，由後處理服務持久化至審計庫。MicroUAC 是其緊湊形式。

### Tentative / Committed（暫存 / 已提交）
審計軌跡的兩個狀態。變更落主庫前先以 Tentative 寫入審計；主庫原子寫入成功後再轉為 Committed，以防中途失敗造成不一致。

### Shadow System（影子系統）
與生產系統平行運行、接收鏡像流量的驗證用系統。校驗服務比對影子與生產的餘額與審計軌跡，要求 100% 一致。
