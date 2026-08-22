---
name: factory-workflow
description: 工廠 agent 處理一個 GitHub Issue 工作項的主流程 SOP。載入本 skill 後依序執行：讀 Issue、寫測試、實作、自審、拆 stacked PR、回報，並在結束前寫出執行報告。
---

# 工廠主流程

處理 GitHub Issue #<編號>（由任務描述提供，repo 為當前 workspace 的 repo）。

## 步驟

1. 讀取該 Issue 的內容與驗收條件（`gh issue view <編號>`）。
2. 判斷是否有可驗證的驗收條件：若 Issue 沒有明確的驗收條件（無重現步驟、無「完成 = 可觀察結果」的描述），**不要猜測**——將 `hasAcceptanceCriteria` 設為 `false` 並依 factory-stop-rules 停手。
3. 依「測試先行」順序作業：先寫測試（定義「正確」），再實作使其通過，最後補文件。
4. 依 factory-pr-stacking 的規則拆分並建立 stacked PR。
5. 提交前依 factory-self-review 自審。
6. 在 Issue 留言回報產出的 PR 編號與摘要。
7. **結束前，在 workspace 寫出執行報告**：

```json
{
  "issueNumber": <編號>,
  "invocation": { "exitCode": 0, "stdout": "<最後一則輸出>", "stderr": "" },
  "changedPaths": ["<改動檔案相對路徑>"],
  "changedLines": <總變更行數>,
  "assertionDelta": <測試斷言淨增減，負數表示減少>,
  "addedDependencies": ["<新增相依套件名>"],
  "syncFailures": <gh stack sync 連續失敗次數>,
  "hasAcceptanceCriteria": <true|false>
}
```

寫入路徑：`.factory/run/report.json`（位於 workspace 根目錄）。此報告是 CI 判定終點的輸入；**欄位缺漏時 CI 會以最保守方式處理**，但完整填寫能讓人類接手時看到全貌。

## 任務型別

任務描述會指明型別（agent-add-tests / agent-fix-bug / agent-update-deps / agent-write-docs）。依型別調整：

- **agent-add-tests**：01-test 層是主體；若既有測試已充分覆蓋，依 factory-stop-rules 誠實停手（不為交差而製造無意義測試）。
- **agent-fix-bug**：先寫「重現失敗」的測試（紅），再實作修復（綠）。不刪除/弱化既有斷言。**01-test 層的紅燈測試以 `it.skip` 提交**（斷言完整保留、該層單獨 CI 綠；紅燈驗證在沙箱內完成）；**02-impl 層 un-skip（改回 `it`）**並含修復——否則 01-test 單獨 PR 必然 CI 紅（docs/07 §2.2 教訓，試點 #3）。
- **agent-update-deps**：通常是單一 PR（docs/07 §2.3）；不得未經核可新增未鎖定的新套件（SR5）；更新後全量測試。
- **agent-write-docs**：文件與實作一致；繁體中文；單層 PR 為主。

## 原則

- 所有 git/gh 操作使用 GitHub App 身分：**若環境變數 `GH_TOKEN` 不存在，先執行**
  `export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)`（短效 installation token，
  由 CI 寫入 workspace；讀取失敗則依 factory-stop-rules 停手）。**永不把 token 寫入任何
  會進 git 的檔案**（如 commit message、文件、測試）。
- **目標 repo 與 trunk 分支也以檔案傳遞**（DSH 會剝離 process env；工作目錄可能是
  其他 repo 的 checkout）：`export GH_REPO=$(cat .factory/run/repo 2>/dev/null)`、
  `export BASE_BRANCH=$(cat .factory/run/base-branch 2>/dev/null)`。`GH_REPO` 讓 gh 的
  issue/PR 操作指向目標 repo；`BASE_BRANCH` 是 PR 合併目標（stack 的 base）——
  **絕不 push 到 main**（Q-P2-1）。
- `git push` 的認證已由 CI 設定（remote URL 內嵌 App token，優先於任何 credential helper）——**直接 push 即可**，不要自行改 remote URL、不要寫入 token 到任何檔案。


- **分支命名**：格式 `factory/<issue編號>-<nn>-<layer>`（如 `factory/12-01-test`）為唯一允許；gh-stack **v0.1.0** 用 `gh stack init --base "$BASE_BRANCH" factory/<issue>-01-test ...` 直接列分支名建立（**不接受** `--numbered`/`--prefix`）；不得自行命名（如 `08-18-docs_...`）或以 dash 取代 slash。
- **PR 一律非 draft**：`gh stack submit --auto` 或 `gh pr create` 皆不可加 `--draft`（draft 無法合併，擋住審查流程）。

- 任務描述本身不重複本 skill 內容——需要細節時回到本檔案。
- 任何不確定的情況，依 factory-stop-rules 停手，**不要猜測並繼續**。
