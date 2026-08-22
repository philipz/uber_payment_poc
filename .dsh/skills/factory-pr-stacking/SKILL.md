---
name: factory-pr-stacking
description: 如何把一個工作項的變更拆分為一疊可獨立審查的 stacked PR（docs/07）。含 gh stack 指令序列與 CI 環境下的注意事項。
---

# Stacked PR 拆分

## 標準三層（由底而頂）

base = `$BASE_BRANCH`（工廠 trunk；由 CI 寫入 `.factory/run/base-branch`，先
`export BASE_BRANCH=$(cat .factory/run/base-branch 2>/dev/null)`）——**絕不 push 到 main**（Q-P2-1）。

```
trunk ($BASE_BRANCH)
  └── 01-test    測試/契約先行
        └── 02-impl    實作
              └── 03-docs    文件與註解
```

## 指令序列（CI 環境，全部非互動）

> **版本相容（重要）**：CI 鎖定 gh-stack **v0.1.0**——它的 `gh stack init` **不接受** `--numbered`/`--prefix`（2026-08-18 試點 #2 實測：那兩個 flag 在 v0.1.0 不存在；部分早期文件與本機舊版 0.0.2 有，但 CI 用 v0.1.0）。v0.1.0 的正確用法是**直接列出各層分支名**（init 會依序建立，slash 保留）。**分支名格式：`factory/<issue編號>-<nn>-<layer>`**（如 `factory/12-01-test`）。

```bash
export GH_TOKEN=$(cat .factory/run/gh-token 2>/dev/null)
export GH_REPO=$(cat .factory/run/repo 2>/dev/null)
export BASE_BRANCH=$(cat .factory/run/base-branch 2>/dev/null)
# 三層：01-test → 02-impl → 03-docs（init 依序建立；單層任務只列一層）
gh stack init --base "$BASE_BRANCH" \
  "factory/<issue編號>-01-test" \
  "factory/<issue編號>-02-impl" \
  "factory/<issue編號>-03-docs"
git add tests/
gh stack add -m "test: add failing tests for issue #<編號>" -A
# ...實作...
gh stack add -m "feat: implement for issue #<編號>" -A
# ...文件...
gh stack add -m "docs: update notes for issue #<編號>" -A
gh stack submit --auto
```

## 必須遵守

- **分支一律經 `gh stack init --base "$BASE_BRANCH" factory/<issue編號>-<nn>-<layer>` 建立**——分支名必須以 `factory/` 前綴開頭並含 Issue 編號（2026-08-18 試跑發現：部分 run 未遵循此慣例，造成分支無法與 Issue 對應；試點 #2 亦見 `factory-569-01-test` 用 dash 取代 slash 的偏差——**slashes 保留，勿用 dash 代替**）。**不允許**自行命名分支（如 `08-18-docs_...`）、用 `--numbered`/`--prefix`（v0.1.0 不支援）或直接 `git branch` 建分支。
- **base 一律用 `$BASE_BRANCH`**（`.factory/run/base-branch`），不得寫死 `main`——對非試點 repo，main 是受保護的真實 trunk，絕不觸碰（Q-P2-1）。
- **`gh stack add` 永遠提供 `-m`**：省略時會開啟編輯器，在 CI 中卡住直到逾時。
- **`gh stack submit` 使用 `--auto`**：不互動提示；**不要加 `--draft`**（draft PR 無法合併，會擋住人類審查流程）。
- **同步一律用 `gh stack sync`，不用 `gh stack rebase`**：`sync` 非互動、衝突時自動還原所有分支（交易性）；`rebase` 衝突時需互動介入。
- `gh stack sync` 連續兩次失敗 → 依 factory-stop-rules 停手。
- **每層必須獨立綠燈（docs/07 §2.2）**：測試層不得引用尚未存在的 API（如未 export 的函式）——那會讓該層單獨無法編譯。若測試需要一個不存在的 export，**把該 export 併入測試層本身**（export 是測試基礎設施）；02-impl 只放真實的行為變更，不放純 export/改名。
- **合併時機**：gh-stack 建立的疊層 PR 在 GitHub 端受「stacked PR 合併限制」——合併需逐層處理，若 merge 被擋（`part of a stack` 且無 async merge API），先 `gh stack checkout <PR>` + `gh stack unstack` 解除關聯再合併。
- **拆分上限 200–300 行**（撰寫指引，非閘門）；超過則再拆。
- **不可跨風險層級**：高風險變更單獨成 PR，不與低風險混在一起。
- 每顆 PR 描述含：做什麼（一句話）、為什麼這樣做、在疊中的位置、審查重點、`Closes #<編號>`。

## 不適用 stacking 的情況

變更 < 100 行且單一關注點（如 typo 修正）或純機械式全域替換 → 用單一 PR。
