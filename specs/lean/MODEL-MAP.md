# Model map — 驗證 claim ledger（Lean 階段③，proofs）

> 沒有寫在這裡的 claim 就不算涵蓋。`verify-lean.sh` 只檢查機械部分；本檔是人類（G3）的閱讀入口。
> **proofs 階段完成（2026-10-29）：** 三條 headline 零 `sorry`、statement snapshot 未變、
> `verify-lean.sh` 全綠。

- **Verified at commit：** `35ffa009ad47a2f467db00351901db1de1dc5758`（`main`，2026-10-29）
  — 本工作區 agent 啟動前的不可變 base commit。
- **Rules of record：** `specs/quint/RULES.md`（G1 confirmed 2026-10-29 by philipz）；
  Lean 轉錄見 `specs/lean/RULES.md`。
- **G2 triage：** `specs/quint/TRIAGE.md:10` — `inv8-early-close`：`real`、`toLean=yes`、`security=no`。
- **Toolchain：** Lean `4.35.0`（`lean-toolchain`：`leanprover/lean4:v4.35.0`）；Mathlib：**no**；
  無新增依賴。

> **唯讀輸入：** `specs/lean/RULES.md` 是 G3 簽核的規則轉錄，proofs 階段**未修改**
> （sha256 與 `.factory/verify-restored.json` 的還原紀錄相符）；`specs/quint/**` 亦全部未修改。
> G3 簽核與證明結果記在本檔 Review log 與 `REPORT.md`，不寫回 `RULES.md`。

## Verified sources（模型聲稱描述的程式碼）

| File | Lines | What is modeled |
|---|---|---|
| `src/shared/lua.ts` | `9-25` | `ACCUMULATE_LUA`：`windowStart = floor(now/windowMs)*windowMs`；bucket 不存在才建立（`isNew`）並 arm timer；存在則 append。 |
| `src/shared/lua.ts` | `30-53` | `CLOSE_ONE_LUA`：`LRANGE` → `ZREM` → `DEL` → 非空則 `LPUSH` 一筆 task；**沒有** TIME 重查。 |
| `src/shared/lua.ts` | `74-102` | `SWEEP_LUA`：只取 `score = windowStart+250 <= now` 的 bucket，關閉形狀與 `CLOSE_ONE_LUA` 相同。 |
| `src/services/batch-creator/index.ts` | `216-235` | batched ingress 呼叫 `ACCUMULATE_LUA`；`isNew === 1` 時以 `setTimeout(closeWindow(bucket), msUntilClose)` arm timer。 |
| `src/services/batch-creator/index.ts` | `72-80` | `closeWindow` 只呼叫 `CLOSE_ONE_LUA`。 |
| `src/shared/keys.ts` | `7` | `WINDOW_MS = 250`。 |

## Rule coverage — headline theorem 的規則、出處、statement snapshot

| Rule | Headline theorem | Statement（snapshot，statements 階段） | Model definition | Source file:line | Why this statement covers the rule |
|---|---|---|---|---|---|
| L1（INV-8） | `UberPayment.earlyClose_two_tasks_same_window` | `∃ t1 t2 : Task, t1 ∈ earlyCloseState.tasks ∧ t2 ∈ earlyCloseState.tasks ∧ t1.key = t2.key ∧ t1.taskId ≠ t2.taskId ∧ t1.closedBy = ClosePath.timer ∧ t2.closedBy = ClosePath.timer ∧ t1.closedAt < WINDOW_MS ∧ t2.closedAt < WINDOW_MS` | `earlyCloseState`、`task0`、`task1`、`Step.timerClose` | `src/shared/lua.ts:30-53`；`src/shared/lua.ts:9-25`；`src/services/batch-creator/index.ts:232-236` | 具體說出 G2 反例的形狀：同一 key 的兩個 task，且兩次都由 timer 在 deadline 前關閉。 |
| L1（INV-8） | `UberPayment.inv8_refuted_by_early_close` | `∃ s : State, Reachable s ∧ ¬ Inv8 s` | `Inv8`、`Reachable`、`Step` | `specs/quint/RULES.md:46`；`src/shared/lua.ts:30-53` | 封裝成「as-is 模型存在可達狀態違反 INV-8」——G2 判定為 real 的缺陷。 |
| L1＋L4（條件式邊界） | `UberPayment.inv8_under_deadline` | `∀ (s : State), SafeReachable s → Inv8 s`（Lean：`theorem inv8_under_deadline (s : State) (h : SafeReachable s) : Inv8 s`） | `Inv8`、`SafeReachable`、`SafeStep` | `specs/quint/RULES.md:46`、`:57`；`src/shared/lua.ts:30-36`、`:78-79` | 若兩條關窗路徑都要求 `windowStart+250 <= now`，同一窗口不可能重建，INV-8 成立；用來界定 G2 缺陷的充分條件。 |

**Proof status（proofs，2026-10-29）：** 三條 headline 全部零 `sorry` 證明；statement snapshot
逐字未變。`inv8_under_deadline` 的證明在 `Specs/Invariant.lean`（`Good` 歸納不變量，見下節）。

**Helper lemmas（不是 headline）：** `earlyClose_s1_reachable`、`earlyClose_s2_reachable`、
`earlyClose_s3_reachable`、`earlyClose_trace_reachable`、`earlyClose_before_deadline`、
`earlyClose_breaks_inv8`、`safe_s1_reachable`…`safe_s9_reachable`、`twoWindow_safe_reachable`、
`inv8_of_two_tasks`、`twoWindow_inv8`。

## Statement stability

proofs 階段未修改任何 headline 的型別或敘述：`Specs/Proofs.lean` 只把 `inv8_under_deadline` 的
`by sorry` body 換成 `inv8_under_deadline_aux s h`；其餘兩條與上面的 snapshot 逐字相同。
`headline-theorems.txt` 未變。

## Proof architecture（`Specs/Invariant.lean`）

`Good s` 是 `SafeStep` 的歸納不變量，四個 conjunct：

1. `Inv8 s`；
2. 任一 bucket key 不等於任何已建立 task 的 key；
3. 每個 task 滿足 `key.windowStart + WINDOW_MS <= closedAt`（關窗不早於 deadline）；
4. 每個 task 滿足 `closedAt <= now`。

`newKey_not_mem_tasks` 用 (3)(4) 與 `now < windowStartOf now + 250` 證明：`ingest` 要建立的
window key 不可能已有 task——否則 `k + 250 <= closedAt <= now < k + 250`。
`good_close` 用 (2) 證明新 task 的 key 不與既有 task 重複；`filter` 保證留下的 bucket key
不是 `k`。`good_ingest`／`good_tick` 逐項保持。`inv8_under_deadline_aux` 對 `SafeReachable`
歸納，投影出 (1)。

## Non-vacuity witnesses

| Theorem | Witness（concrete instantiation） | Satisfiability note |
|---|---|---|
| `earlyClose_two_tasks_same_window` | `task0`、`task1` ∈ `earlyCloseState.tasks`；`task0.key = task1.key = (hot-account-1, 0)`；`taskId` 0 ≠ 1；`closedAt = 0 < 250` | 由 `decide` 機器檢查（`Specs/Proofs.lean:52-60`）。這是 G2 trace 的四步：ingest tx-4 → timer close → ingest tx-3 → timer close，全部在 `now=0`。 |
| `inv8_refuted_by_early_close` | `earlyCloseState` | `earlyClose_trace_reachable`（四步 `Reachable` 證明）＋`earlyClose_breaks_inv8`（由兩個相異 task 同 key 推出矛盾）。 |
| `inv8_under_deadline` | `twoWindowState`：窗口 0 與 250 各一個 task | `twoWindow_safe_reachable`（ingest 0 → sweep 250 → ingest 250 → sweep 500）＋`twoWindow_inv8`；task set 非空，key 相異。假設可滿足，不是空真。 |

## Abstraction ledger — 丟掉的細節與為何不影響 INV-8

| Dropped detail | Where（source file:lines） | Safety argument |
|---|---|---|
| Worker、`BLMOVE`／reclaim、OCC、DB transaction、`processed`、`audit`、`finalize` | `src/services/batch-process/index.ts:82-282`、`:302-339` | INV-8 是 task 集合的性質；task 一旦 `LPUSH` 就不會被 worker 刪除或改 key。worker 只會消費 task，不能讓同一 key 多出第二個 task，也不能讓已存在的第二個 task 消失。G2 trace 在 task 2 建立時即停止，正好在 worker 之前。 |
| `windows:active` ZSET 與 score | `src/shared/lua.ts:22`、`:79` | sweep 的「到期」條件直接建成 `windowStart+WINDOW_MS <= now`；ZSET 只是索引，不改變哪些 bucket 到期。 |
| `Queued`／`Processing`／`Committed` 事件 | `src/shared/lua.ts:47-52`、`:95-97` | Q5／OUT-9 已把事件流排除在不變量外；事件不改變 bucket／task 集合。 |
| `PEXPIRE windowMs+60000`（bucket TTL） | `src/shared/lua.ts:20` | ENV-5：TTL 只可能讓未關窗交易遺失，不會在同一 Redis TIME 下重建同一個 `windowStart`（TTL 遠大於窗口）；不會製造 INV-8 反例，也不遮蓋 G2 的早關反例。 |
| timer 的 `msUntilClose` 計算與 setTimeout 排程 | `src/services/batch-creator/index.ts:232-236` | 模型把 timer 建成「可在任意 `now >= windowStart` 關閉」——比實際排程**更寬**（涵蓋所有提前量）。若在此寬鬆模型下找到反例，實際 timer 提前時也可能發生；不會把不可能的行為當成缺陷。 |
| `taskId` 的實際字串（bucket key） | `src/shared/lua.ts:43-46` | 模型用單調 Nat 抽象 task identity；同一 key 的兩個 task 仍是兩個相異 task，足以陳述 INV-8。 |
| account 域抽樣為 `hot-account-1` | `db/init.sql:33-35`、`src/services/batch-creator/index.ts:68` | 模型對 `account` 是參數化的（`ingest` 接受任意 String）；concrete trace 用 seeded account 只因 G2 trace 用它。這不是程式限制。 |
| `op`／`amount`／交易內容 | `src/shared/operations.ts:5-18` | INV-8 只看 `(account, windowStart)`；交易的 op／amount 不影響 key 計算或關窗。保留在 `Txn` 只為讓 concrete trace 可辨識。 |
| `now` 的毫秒來源（Redis `TIME` 秒+微秒換算） | `src/shared/lua.ts:13-14` | 模型用 Nat 毫秒並以 `tick (d > 0)` 單調推進；這是 Redis TIME 的抽象，且不限制提前量。 |

## Bounded port audit（model ↔ code）

| Check | Result |
|---|---|
| Guards | `ACCUMULATE_LUA` 的 `EXISTS`（append vs create）→ `ingest` 的 `findBucket`；`CLOSE_ONE_LUA` 沒有 TIME guard → `Step.timerClose` 只有 `windowStart <= now`；`SWEEP_LUA` 的 `ZRANGEBYSCORE 0 nowMs` → `Step.sweep` 的 `windowStart+250 <= now`。 |
| Order | `ingest` 先算 windowStart 再找／建 bucket；`closeBucket` 先 `findBucket` 再移除並產生 task；皆與 Lua 的 `LRANGE`→`ZREM`→`DEL`→`LPUSH` 順序一致（模型中為原子一步）。 |
| Outcomes | 非空 bucket close → 恰一 task；bucket 不存在 → no-op；empty bucket 不可達（建立時即含第一筆交易）。 |
| Boundaries | `now=0`、`now=249`、`now=250`、`now=500`；同 key 重複 ingest；重複 close；deadline 前／後。 |
| Dropped details | 見上表；每一項都給出不影響 INV-8 的理由，而非只寫「persistence」。 |

## Explicitly not covered

- `INV-1`～`INV-7`、`INV-9`：餘額守恆、audit=processed=applied、version、txid 一次、原子性、48-byte audit、no-op、無未審計變更。
- Worker／OCC／replay／audit／processed／finalize 管線（`src/services/batch-process/index.ts`）。
- 「同一 key 的兩個 task 都被處理 → 重複套用／version +2」的後果：G2 未確認
  （`specs/quint/REPORT.md:164-166`），Lean 模型不宣稱。
- SSE 事件順序（Q5／OUT-9）、naive 模式（Q8／OUT-10）、多 creator（Q15／OUT-11）、
  TTL 遺失（ENV-5）、HTTP 200／409／504（Q4）、跨帳戶 txid（ENV-1／OUT-12）。
- `transactionId` 全域唯一與 payload 固定（ENV-1）：INV-8 不依賴 txid；模型不模擬跨帳戶重用。
- at-least-once／兩個交錯 attempt（ENV-3／Q13）：worker 不在模型內；task 建立後的消費不影響 INV-8。
- Redis／Postgres 的真實語義、crash recovery、網路、時鐘同步實作、效能。
- 真實系統語意不在 `inv8_under_deadline` 的證明範圍內：證明只涵蓋 Lean 模型，不涵蓋
  真實 Redis／Postgres 語意、時鐘或 worker 管線。

## Verification gate checklist（proofs 階段）

- [x] `RULES.md` 有 confirmed-by（philipz）、日期、出處、acceptance；Open questions 已列。
- [x] Verified sources 逐條映射 `file:line`；abstraction ledger 完整。
- [x] Statement snapshot 已記錄；proofs 階段逐字未變（見 Statement stability）。
- [x] 每條 headline theorem 有非空洞 witness；三條的 witness 都已機器檢查。
- [ ] 獨立 adversarial review：**未取得**（兩個 fresh-context subagent 均未在本次工作項時限內回報，已 interrupt）；依 skill 的 participant-unavailable fallback 改以 **self-review（weaker）** 完成 statement 穩定性／非空洞性／守則檢查（見 Review log）。此項標為未獨立滿足。
- [x] Owner／G3 讀過 top-level statements 並簽核：philipz，2026-10-29，Issue #74 proofs 派工。
- [x] `verify-lean.sh` 全綠：build／direct compile／coverage／guardrails／axiom audit 全 PASS。
- [x] Dashboard baseline＋current：`metrics-baseline.txt` 已存（proofs 首次零 `sorry` 綠燈）。
- [x] Bounded port audit（guards／order／outcomes／boundaries／dropped details）已完成，見上表。

## Review log

| Date | Reviewer | Kind | Findings | Resolution |
|---|---|---|---|---|
| 2026-10-29 | philipz（G2） | human／Quint model checking | `inv8-early-close`：`real`、`toLean=yes`、`security=no` | 轉錄為 Lean headline `inv8_refuted_by_early_close` |
| 2026-10-29 | philipz（G3） | human／statement sign-off | Issue #74（`Lean proofs`）派工＝G3 簽核訊號；statements 產出（Issue #72）齊備、base `35ffa00` 未變 | 進入 proofs；三條 headline 敘述未變更 |
| 2026-10-29 | self-review（weaker） | adversarial self-check | fresh-context subagent 兩次均未在時限內回報（已 interrupt），依 skill fallback 改以 self-review：(1) 三條 statement 與 snapshot 逐字相同；(2) `Good` 四 conjunct 對 `ingest`／`tick`／`close` 逐一保持（`close` 以 `filter` 保證剩餘 bucket key ≠ k；`ingest` 的 none case 用 deadline 矛盾）；(3) `twoWindowState` 可達、task set 非空；(4) `.lean` 零 `sorry`、零禁用建構、axiom audit 3/3。無 blocker。 | 記錄為 self-review（weaker）；獨立 adversarial review **未獨立滿足**，不影響機械閘門 |

## Re-sync log

| Date | Commit | Sources changed | Rule affected | Theorems touched | Notes |
|---|---|---|---|---|---|
| 2026-10-29 | `35ffa00` | 初次建立 Lean 模型（無程式碼變更） | L1–L5 | 全部 | statements 階段；`inv8_under_deadline` 為 `sorry` |
| 2026-10-29 | `35ffa00`（dirty workspace） | 無程式碼變更；新增 `Specs/Invariant.lean`、移除 proof body 的 `sorry` | L1／L5 | `inv8_under_deadline` | proofs 階段；零 `sorry`、gate PASS |
