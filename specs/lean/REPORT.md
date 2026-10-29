# Lean report — philipz/uber_payment_poc（Issue #74，階段③ proofs）

- **Repo：** `philipz/uber_payment_poc`
- **Issue：** #74（形式化驗證服務，ADR-029 §5；`agent-verify-lean`）
- **階段：** `proofs`（`.factory/run/verify-phase` = `proofs`；本次**只做**此階段）
- **驗證基準：** 本工作區 base commit `35ffa009ad47a2f467db00351901db1de1dc5758`（`main`，agent 啟動前）
- **規則來源：** `specs/quint/RULES.md`（G1 確認版 v2，唯讀）；G2 判定 `specs/quint/TRIAGE.md:10`
- **G3 簽核：** Issue #74（`Lean proofs`）派工＝機制端 G3 簽核訊號（task template 明定）；
  statements 產出（Issue #72）齊備、base 未變。見 `MODEL-MAP.md` Review log。
- **工具鏈：** `leanprover/lean4:v4.35.0`，Lean core，**無 Mathlib**、無新增依賴
- **狀態：** proofs 階段完成（模型範圍內）；**零 `sorry`**、閘門 RESULT **PASS**。

## 1. 本階段做了什麼

把 statements 階段留下的唯一未證明項 `inv8_under_deadline` 補完：

- 新增 `Specs/Invariant.lean`：定義強化不變量 `Good`，證明它在每一個 `SafeStep` 下保持
  （`good_init`、`good_ingest`、`good_tick`、`good_close`、`good_step`），再對
  `SafeReachable` 歸納得到 `inv8_under_deadline_aux`。
- `Specs/Proofs.lean` 的 headline 3 只把 body 由 `by sorry` 改為
  `inv8_under_deadline_aux s h`；**型別與敘述逐字未變**。
- 更新 `Audit.lean`／`Specs/Examples.lean` 的階段註解（不再期待 `sorryAx`）。
- 建立 `metrics-baseline.txt`（第一次零 `sorry` 綠燈的 dashboard 快照）。

**沒有做**：沒有修改 `src/**`、`specs/quint/**`、`.github/**`、`docs/**`；沒有建立分支、
沒有 `git push`、沒有開 PR、沒有在 Issue 留言或寫入任何發現、沒有貼標籤。沒有安裝 Mathlib
或任何依賴。

## 2. 模型與定理

模型：`specs/lean/Specs/Model.lean`（250 ms 窗口生命週期、timer／sweep 兩條關窗路徑）。
證明：`specs/lean/Specs/Invariant.lean`。Headline 清單：`headline-theorems.txt`（3 條）。

| # | Headline theorem | 陳述 | 本階段狀態 |
|---|---|---|---|
| 1 | `UberPayment.earlyClose_two_tasks_same_window` | G2 trace 形狀：兩個相異 task 同 key，皆由 timer 在 `closedAt < 250` 關閉 | **已證明**（`decide`＋具體 witness） |
| 2 | `UberPayment.inv8_refuted_by_early_close` | `∃ s, Reachable s ∧ ¬ Inv8 s` | **已證明**（由 1 與 trace reachability） |
| 3 | `UberPayment.inv8_under_deadline` | `∀ s, SafeReachable s → Inv8 s` | **已證明**（`Good` 歸納不變量；本階段新增） |

### 證明架構（headline 3）

`Good s` 是 `SafeStep` 的歸納不變量，四個 conjunct：

1. `Inv8 s`；
2. 任一 bucket key 不等於任何已建立 task 的 key；
3. 每個 task 滿足 `key.windowStart + WINDOW_MS <= closedAt`；
4. 每個 task 滿足 `closedAt <= now`。

關鍵引理 `newKey_not_mem_tasks`：若 `ingest` 要建立的 window key 已有 task，則由 (3)(4)
得 `k + 250 <= closedAt <= now`，但 `k = windowStartOf now` 又給 `now < k + 250`，矛盾。
`good_close` 用 (2) 證明新 task 的 key 不與既有 task 重複；`filter` 保證留下的 bucket key
不是 `k`。`good_ingest`／`good_tick` 逐項保持。完整敘述見 `MODEL-MAP.md` 的
Proof architecture 與 statement snapshot。

### 非空洞 witness

- headline 1／2：`earlyCloseState`（G2 trace 四步），task set 非空且真的違反 INV-8。
- headline 3：`twoWindowState`（窗口 0 與 250 各一 task，皆在 deadline 後 sweep），
  `twoWindow_safe_reachable` ＋ `twoWindow_inv8`；假設可滿足、task set 非空，不是空真。

## 3. 閘門結果（如實）

命令（repo 根目錄；skill 的 `verify-lean.sh`）：

```bash
bash <skill>/scripts/verify-lean.sh \
  --dir specs/lean --main Specs/Proofs.lean --audit Audit.lean \
  --theorems headline-theorems.txt --baseline specs/lean/metrics-baseline.txt
```

| 檢查 | 結果 |
|---|---|
| Clean build | **PASS**：`Build completed successfully (7 jobs).` |
| Direct compile（main） | **PASS**：`the main proof file compiles directly (not dead code)` |
| Compile coverage | **PASS**：4 files compile directly（unimported files cannot hide） |
| Guardrails | **PASS**：6 個 `.lean` 檔（去註解／字串後）**0 hits**；無 `sorry`／`axiom`／bodyless `opaque`／`native_decide`／`unsafe`／`extern`／`@[implemented_by]` |
| Axiom audit | **PASS**：3/3 headline 都回報；全部在 allowlist |
| Dashboard | **PASS**：`metrics-baseline.txt` 已存；current 與 baseline 全部 delta 0 |
| **RESULT** | **PASS**（exit 0） |

Axiom audit 逐字：

```
'UberPayment.earlyClose_two_tasks_same_window' depends on axioms: [propext]
'UberPayment.inv8_refuted_by_early_close' depends on axioms: [propext]
'UberPayment.inv8_under_deadline' depends on axioms: [propext, Quot.sound]
```

`propext` 與 `Quot.sound` 都在 skill 的 allowlist 內；沒有 `sorryAx`、沒有新 axiom。

## 4. 牆鐘

| # | 命令 | 牆鐘 |
|---|---|---:|
| 1 | `rm -rf .lake && lake build`（clean，7 jobs） | 2.06 s |
| 2 | `lake env lean Audit.lean` | 0.35 s |
| 3 | `verify-lean.sh`（build＋direct＋coverage＋guard＋audit＋metrics，最終 baseline 重跑） | 2–3 s（腳本自報） |

沒有長時間模型檢查或下載；工具鏈已預先安裝，未新增任何依賴。

## 5. 獨立 adversarial review

- **執行方式：** 嘗試兩個 fresh-context subagent（read-only；其中一個被要求只讀 4 個檔、
  不做 build），但兩者均未在本次工作項時限內回報，已 interrupt。依 skill
  `references/workflow-prompts.md` 的 participant-unavailable fallback，改以
  **self-review（weaker）** 逐項檢查，並如實標記此項**未獨立滿足**。
- **Self-review 結果（weaker）：**
  1. **Statement stability：** 三條 headline 的型別／敘述與 statements 階段 snapshot 逐字相同；
     `Specs/Proofs.lean` 只改 proof body（`by sorry` → `inv8_under_deadline_aux s h`）與註解。
  2. **Invariant preservation：** `Good` 的四個 conjunct 對 `ingest`（some／none）、`tick`、
     `close` 逐一檢查。`close` 以 `filter` 保證剩餘 bucket key ≠ k；`ingest` 的 none case
     用 `k + 250 <= closedAt <= now < k + 250` 的矛盾；`tick` 只放寬 `now` 上界。
  3. **Non-vacuity：** `SafeReachable.init` 使假設可滿足；`twoWindowState` 可達且 task set
     非空（key 0 與 250），`twoWindow_inv8` 已機器檢查。
  4. **Guardrails／axioms：** `.lean` 零 `sorry`、零禁用建構；axiom audit 3/3，僅
     `propext`／`Quot.sound`。
- **結論：** 無 blocker；但**獨立 adversarial review 未獨立滿足**（self-review 較弱）。
  此限制不影響 `verify-lean.sh` 的機械閘門結果。

## 6. 這個報告**不**宣稱什麼

- **不宣稱整個系統 verified。** 證明只涵蓋 `specs/lean` 的抽象模型（窗口／bucket／task
  生命週期）；worker、OCC、replay、audit、processed、finalize、Redis／Postgres 真實語意、
  crash recovery、時鐘、效能都不在模型內。
- **不宣稱 as-is 程式滿足 INV-8。** 相反的，headline 1／2 機器證明了 G2 的 `real` 判定：
  as-is 模型存在可達狀態違反 INV-8（timer 早關 + 同窗重建）。
- **不宣稱條件式定理等於「程式已修好」。** `inv8_under_deadline` 只說：若兩條關窗路徑都
  尊重 `windowStart+250`，模型滿足 INV-8。這是邊界，不是對 `src/**` 的修復或背書。
- **不宣稱反例後果。** 「同一 key 的兩個 task 都被 worker 處理 → 重複套用／version +2」
  G2 未確認；Lean 模型沒有 worker，因此不陳述。
- **不涵蓋** `INV-1`～`INV-7`、`INV-9`、SSE 順序、naive、多 creator、TTL、HTTP 狀態、
  跨帳戶 txid（詳見 `MODEL-MAP.md` 的 not-covered 清單）。

## 7. 未決事項（open questions）

1. **G3 文本簽核欄位：** statements 階段的 `RULES.md` 記為 `<pending G3>`；`RULES.md` 是
   proofs 階段的唯讀還原輸入（機制端 crosscheck 會比對 sha256，proofs 階段不可改寫），
   因此本次把 G3 簽核記在 `MODEL-MAP.md` Review log 與本報告，而非寫回 `RULES.md`。
   本次依 task template「以 proofs 派工即代表 G3 已簽核」，以 Issue #74 派工為 G3 訊號；
   若機制端要求另一份獨立的人類簽名，請在發布前補記。
2. **反例後果：** 同一 key 的兩個 task 若都被 worker 處理，是否造成重複套用／version +2？
   G2 未在 TRIAGE 確認；本次 Lean 模型刻意不陳述。若納入，需回到 G2／G1 擴充 triage。
3. **`Queued` 事件恰好一次：** RULES ACT-2 提到 `Queued`，但 Q5／OUT-9 把事件流排除；
   本次模型不含事件。若 G3 要求，需另建事件模型。
4. **worker／OCC 的 Lean 化：** 本次只做 G2 送 Lean 的 `inv8-early-close`；`INV-1`／
   `INV-4`／`INV-9` 的 Lean 證明不在本次範圍，是否另開工作項由人類決定。

## 8. 下一步（不由本 agent 執行）

1. 機制端取回工作區產出與加密 artifact；`factory.verify.publish` 在 G2 之後發佈 PR。
2. 完成訊號 `stage/done` 由機制端貼上；本 agent 不貼標籤、不開 PR、不 push。
