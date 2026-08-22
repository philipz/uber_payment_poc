---
name: factory-stop-rules
description: 工廠 agent 必須停手並交還人類的情況。任何一條觸發即停止，不得自行放寬。
---

# 停手規則

以下任一情況發生時，**立即停止**，在 Issue 留言說明原因，貼上 `needs-human` 標籤，然後結束：

1. 同一顆 PR 連續兩次 `gh stack sync` 失敗。（**CI 中一律用 `sync` 不用 `rebase`**：`sync` 為非互動且衝突時會還原所有分支；`rebase` 需互動介入，在 CI 中會卡住至逾時。詳見 docs/07 §3.3）
2. 任務涉及授權邏輯、金流計算、敏感資料處理。
3. 需要修改 CI 設定、branch protection、CODEOWNERS 或 `catalog-info.yaml`。
4. 驗收條件不明確，無法判斷完成與否。
5. 需要新增未在既有相依清單中的套件。
6. 測試無法在不放寬斷言的情況下通過。
7. 本次執行消耗的 token 超過 CI 設定的單一工作項上限（`token_budget`；未設定表示尚未限制，但**不應刻意浪費**）。

**絕不允許的行為**：
- 為了讓測試通過而刪除或弱化測試斷言。
- 為了繞過檢查而修改 guardrail 設定。
- 在不確定時猜測並繼續——不確定就停手。
