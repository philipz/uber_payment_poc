# RULES.md — Lean 形式化（階段③）規則轉錄

> 本檔是 G1 `specs/quint/RULES.md` 的**轉錄**，不是第二份規則來源。Lean 階段不重新訪談、
> 不新增或放寬規則；每一條都附出處。`specs/quint/RULES.md`、`TRIAGE.md`、`REPORT.md` 為唯讀輸入。

- **規則來源：** `specs/quint/RULES.md`（G1 確認版 v2，唯讀）
- **G2 判定：** `specs/quint/TRIAGE.md:10` — `inv8-early-close`：`real`、`toLean=yes`、`security=no`
- **反例報告：** `specs/quint/REPORT.md:146-169`（CF-1）
- **G2 模型出處：** `specs/quint/model.qnt:615-619`（`INV_8_single_batch`）、`:727-737`（`TimerClose`）、`:739-753`（`Sweep`）
- **G1 確認者（confirmed-by）：** philipz（GitHub user id 664465，白名單）
- **G1 確認日期：** 2026-10-29
- **G2 判定者／時間：** philipz / `2026-10-29T01:18:13.185Z`
- **本次轉錄：** statements 階段，2026-10-29
- **驗證基準（本工作區）：** `main` @ `35ffa009ad47a2f467db00351901db1de1dc5758`
  （`specs/quint/RULES.md:5` 記載的 `672fc889…` 不在本 checkout 的可見歷史中；程式證據以本 checkout
  的 `src/**` 為準，規則語義以 G1／G2 產出為準）
- **工具鏈：** `leanprover/lean4:v4.35.0`，Lean core，**無 Mathlib**、無新增依賴
- **狀態：** 規則 `confirmed`；定理敘述 `awaiting G3 sign-off`

## Scope

**In scope（本次 Lean 階段）：**

- `INV-8`（每一 `(accountId, windowStart)` 至多一個 batch／task）在 as-is 模型下的真值。
- 決定 INV-8 的窗口生命週期：`ACT-1`（windowStart 對齊）、`ACT-2`（非空窗關閉恰一 task）、
  `ACT-7`／`Q1`（timer 不重查 Redis TIME，早關可達；sweep 尊重 deadline）。
- 對應的 G2 反例 `inv8-early-close`（`specs/quint/TRIAGE.md:10`）。

**Out of scope（明確不驗證）：**

- `INV-1`～`INV-7`、`INV-9`：worker、OCC、replay、audit、processed、finalize 管線不在本次 Lean 模型內。
- RULES.md `OUT-1`～`OUT-12`：餘額充足性、Tentative 審計、referenceId 冪等、finalize liveness、
  複式記帳、metrics、跨批次全序、businessTime 排序、SSE 順序、naive 模式、多 creator、跨帳戶 txid 重用。
- `ENV-5` 窗口 TTL 遺失；`ENV-4` 事件 best-effort；HTTP 200／409／504 語義。

## Rules

### L1 — INV-8：每個 `(accountId, windowStart)` 至多一個 task

- **Statement（業務語言）：** 對所有可達狀態，若兩個 task 的 `(accountId, windowStart)` 相同，
  則它們是同一個 task；亦即同一帳戶的同一 250 ms 窗口最多產生一個 batch。
- **Source of truth：** `specs/quint/RULES.md:46`；`specs/quint/model.qnt:615-619`；
  G2 反例 `specs/quint/TRIAGE.md:10`、`specs/quint/REPORT.md:146-169`。
- **Positive example：** 窗口 0 與窗口 250 各關閉一次 → 兩個 task，key 不同，INV-8 成立
  （Lean：`twoWindowState`／`twoWindow_inv8`）。
- **Negative example（violation）：** 窗口 0 在 `now=0` 被 timer 關閉；同一窗口在 `now=0`
  又被 `Ingest` 重建；再次被 timer 關閉 → 兩個 task 的 key 都是 `(hot-account-1, 0)`
  （Lean：`earlyCloseState`／`earlyClose_breaks_inv8`）。這是 G2 判定為 `real` 的缺陷。
- **Boundaries：** `now` 是 Redis TIME；timer 路徑沒有 `now >= windowStart+250` 檢查；
  sweep 路徑有；bucket 在關閉時原子移除。

### L2 — ACT-1：`windowStart = floor(RedisTimeMs / 250) * 250`

- **Statement：** 每筆 batched 交易依當下 Redis TIME 歸入 `windowStart = (now / 250) * 250`；
  同一 `(accountId, windowStart)` 的交易進同一個 bucket。
- **Source of truth：** `specs/quint/RULES.md:51`；`src/shared/lua.ts:13-15`（`math.floor(nowMs / windowMs) * windowMs`）；
  `src/shared/keys.ts:7`（`WINDOW_MS = 250`）。
- **Positive example：** `now ∈ [0,249]` → 窗口 0；`now ∈ [250,499]` → 窗口 250。
- **Negative example：** 出現 windowStart 不是 250 的倍數的 bucket／task（模型建立的 key 只來自
  `windowStartOf`，因此不會發生）。
- **Boundaries：** Nat 除法；時間單調遞增；`now` 無上界。

### L3 — ACT-2：非空 bucket 關閉恰產生一個 task

- **Statement：** 關閉一個非空 bucket 時，原子地取出其交易、移除 bucket，並產生**恰好一個**
  task 攜帶該 bucket 的交易；bucket 不存在時 no-op。
- **Source of truth：** `specs/quint/RULES.md:52`；`src/shared/lua.ts:30-53`（`CLOSE_ONE_LUA`：
  `LRANGE` → `ZREM` → `DEL` → `LPUSH` 一筆）；`src/shared/lua.ts:74-102`（`SWEEP_LUA` 同形）。
- **Positive example：** 含一筆交易的 bucket 被 timer 關閉 → task 數 +1，task 攜帶該交易。
- **Negative example：** 同一次關閉產生兩個 task，或空 bucket 產生 task（模型中 bucket 由第一筆
  `Ingest` 建立、同一步移除，空 bucket 不可達；`closeBucket` 對不存在的 key 是 no-op）。
- **Boundaries：** 重複關閉同一 key（bucket 已不存在）→ no-op；`Queued` 事件不在模型內（Q5／OUT-9）。

### L4 — ACT-7／Q1：timer 早關可達，sweep 尊重 deadline

- **Statement：** `CLOSE_ONE_LUA` 在刪 bucket 前**不重查** Redis TIME，因此 timer 路徑可在
  `windowStart <= now < windowStart+250` 的任意時刻關窗；`SWEEP_LUA` 只關閉
  `score = windowStart+250 <= now` 的窗口。
- **Source of truth：** `specs/quint/RULES.md:57`（ACT-7）、`specs/quint/RULES.md:13`（Q1）；
  `src/shared/lua.ts:30-36`（`CLOSE_ONE_LUA` 沒有 TIME 重查）；`src/shared/lua.ts:78-79`
  （`ZRANGEBYSCORE ... 0 nowMs`）；`src/services/batch-creator/index.ts:232-236`
  （`setTimeout(closeWindow(bucket), msUntilClose)`）。
- **Positive example：** `TimerClose` 在 `now=0` 關閉窗口 0（`earlyCloseState` 的兩次 timer close）。
- **Negative example：** `Sweep` 在 `now=0` 關閉窗口 0（模型要求 `0+250 <= 0`，不可達）。
- **Boundaries：** timer 可提前任意量（只要求 `now >= windowStart`）；`SafeStep` 把兩條路徑都
  加上 `windowStart+250 <= now`，用來陳述條件式邊界。

### L5 — INV-8 的條件式邊界（derived boundary，不是新規則）

- **Statement：** 若**兩條**關窗路徑都要求 `windowStart+250 <= now`，則所有可達狀態都滿足 INV-8。
- **Source of truth：** 由 L1（`specs/quint/RULES.md:46`）與 L4（`:57`、Q1）推得；G1 沒有新增規則。
  這是「早關是唯一破口」的模型邊界，用來對照 G2 的 `real` 判定，**不宣稱 as-is 程式滿足 INV-8**。
- **Positive example：** `twoWindowState`（窗口 0 與 250，sweep 於 deadline 後）滿足 INV-8。
- **Negative example：** `earlyCloseState` 不滿足 L5 的假設（`closedAt=0 < 250`），也違反 INV-8。
- **Boundaries：** 條件式；若 timer 可早關，結論不成立（即 G2 反例）。

## Acceptance／sign-off

- **Acceptance（statements 階段）：** 三條 headline theorem 的完整敘述已寫入
  `Specs/Proofs.lean` 與 `MODEL-MAP.md` 的 statement snapshot；`lake build` 通過；
  非空洞 witness 存在；G3 讀過並簽核。`sorry` 僅允許在本階段，且不得當成完成。
- **Acceptance（proofs 階段，G3 之後）：** `inv8_under_deadline` 的 `sorry` 移除；
  `scripts/verify-lean.sh` 全綠；無新 axiom／bodyless `opaque`／`native_decide`／`unsafe`／
  `extern`／`@[implemented_by]`。
- **Sign-off：** <pending G3>（簽核後在此記錄姓名／日期／read statement snapshot）

## Grilling log（不重新訪談；以下為 G1 已回答且與本階段相關者）

| # | 問題 | G1 決定 | 日期 |
|---|---|---|---|
| Q1 | 提前關窗（R-14）是否建模為可達事件？ | 是；`CLOSE_ONE_LUA` 不重查 TIME，模型必須允許 early-close，不得用環境假設排除。 | 2026-10-29 |
| Q13 | 兩個可交錯 attempt？ | 是；以 attempt id 建 A／B 與 reclaim。**本次 Lean 模型不含 worker**，見 MODEL-MAP 的 abstraction ledger。 | 2026-10-29 |
| Q14 | 審計完整性列為不變量？ | 是（INV-9）；**本次 Lean 階段不涵蓋**，G2 只把 `inv8-early-close` 送 Lean。 | 2026-10-29 |
| Q15 | 部署假設？ | 單一 creator／Redis／Postgres；本次 Lean 模型只保留單一時間軸與 bucket 集合。 | 2026-10-29 |

## Open questions（Lean 階段）

1. G2 反例停在「兩個 task 建立」；兩個 task 若都被 worker 處理是否造成重複記帳／version +2，
   `specs/quint/REPORT.md:164-166` 明說「尚未觀察到，交由 G2 分類」，TRIAGE 未列。Lean 模型
   因此**不宣稱**該後果。
2. `inv8_under_deadline` 是否要列入 G3 簽核的 headline set，或只簽 `inv8_refuted_by_early_close`？
   目前兩者都列。
3. `ACT-2` 的 `Queued` 事件不在模型內（Q5／OUT-9），G3 若要求「恰好一次事件」需另開模型。
4. 後續是否要把 worker／OCC 納入 Lean 以證明 INV-1／INV-4？不在本次 G2 triage 範圍。

## Change policy

程式或規則變更導致定理失效時：**不得為了讓證明過關而弱化已確認的定理敘述**。停手，回報哪一條
規則／敘述改變，交 G3（必要時 G1）重新確認。
