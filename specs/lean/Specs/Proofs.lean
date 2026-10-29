import Specs.Model
import Specs.Invariant

/-!
Theorems for the G2 finding `inv8-early-close` (proofs phase).

Headline theorems (also listed in `headline-theorems.txt`):

1. `earlyClose_two_tasks_same_window` — the concrete G2 trace shape: two
   distinct tasks with the same `(account, windowStart)` key, both closed by the
   timer before the 250 ms deadline.
2. `inv8_refuted_by_early_close` — packaged existential: some reachable state
   violates INV-8 (the G2-confirmed defect).
3. `inv8_under_deadline` — if both closing paths respect `windowStart + 250`,
   INV-8 holds for every reachable state (the conditional boundary in RULES.md).

Supporting lemmas (reachability of the trace, the concrete violation, and the
safe two-window non-vacuity witness) are proved below. Headline theorem 3 is
proved from the inductive invariant in `Specs/Invariant.lean`.
-/
namespace UberPayment

/-! ### 1. The G2 trace is reachable -/

theorem earlyClose_s1_reachable : Reachable s1 :=
  Reachable.step Reachable.init (Step.ingest initState "hot-account-1" tx4)

theorem earlyClose_s2_reachable : Reachable s2 :=
  Reachable.step earlyClose_s1_reachable
    (Step.timerClose s1 key0 bucket1 (by decide) (by decide))

theorem earlyClose_s3_reachable : Reachable s3 :=
  Reachable.step earlyClose_s2_reachable
    (Step.ingest s2 "hot-account-1" tx3)

theorem earlyClose_trace_reachable : Reachable earlyCloseState :=
  Reachable.step earlyClose_s3_reachable
    (Step.timerClose s3 key0 bucket3 (by decide) (by decide))

/-! ### 2. The reachable state violates INV-8 -/

/-- The two tasks created by the two timer closes: same key, distinct task ids,
both closed before the 250 ms deadline. -/
theorem earlyClose_two_tasks_same_window :
    ∃ t1 t2 : Task,
      t1 ∈ earlyCloseState.tasks ∧
      t2 ∈ earlyCloseState.tasks ∧
      t1.key = t2.key ∧
      t1.taskId ≠ t2.taskId ∧
      t1.closedBy = ClosePath.timer ∧
      t2.closedBy = ClosePath.timer ∧
      t1.closedAt < WINDOW_MS ∧
      t2.closedAt < WINDOW_MS := by
  refine ⟨task0, task1, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · decide
  · decide
  · decide
  · decide
  · decide
  · decide
  · decide
  · decide

/-- Both closes happened before the 250 ms deadline (at `now = 0`). -/
theorem earlyClose_before_deadline : earlyCloseState.now < WINDOW_MS := by
  decide

theorem earlyClose_breaks_inv8 : ¬ Inv8 earlyCloseState := by
  intro h
  have h0 : task0 ∈ earlyCloseState.tasks := by decide
  have h1 : task1 ∈ earlyCloseState.tasks := by decide
  have hkey : task0.key = task1.key := by decide
  have hsame : task0 = task1 := h task0 h0 task1 h1 hkey
  have hne : task0.taskId ≠ task1.taskId := by decide
  exact hne (congrArg Task.taskId hsame)

/-! ### 3. Packaged refutation (the G2-confirmed defect) -/

theorem inv8_refuted_by_early_close :
    ∃ s : State, Reachable s ∧ ¬ Inv8 s :=
  ⟨earlyCloseState, earlyClose_trace_reachable, earlyClose_breaks_inv8⟩

/-! ### 3b. Non-vacuity of the conditional boundary

A deadline-respecting run with two completed windows (keys 0 and 250) shows the
hypothesis of `inv8_under_deadline` is inhabited by a state with a non-empty task
set, and that such a state still satisfies INV-8. -/

theorem safe_s1_reachable : SafeReachable s1 :=
  SafeReachable.step SafeReachable.init (SafeStep.ingest initState "hot-account-1" tx4)

theorem safe_s5_reachable : SafeReachable s5 :=
  SafeReachable.step safe_s1_reachable (SafeStep.tick s1 250 (by decide))

theorem safe_s6_reachable : SafeReachable s6 :=
  SafeReachable.step safe_s5_reachable
    (SafeStep.close s5 key0 bucket1 ClosePath.sweep (by decide) (by decide))

theorem safe_s7_reachable : SafeReachable s7 :=
  SafeReachable.step safe_s6_reachable (SafeStep.ingest s6 "hot-account-1" tx3)

theorem safe_s8_reachable : SafeReachable s8 :=
  SafeReachable.step safe_s7_reachable (SafeStep.tick s7 250 (by decide))

theorem safe_s9_reachable : SafeReachable s9 :=
  SafeReachable.step safe_s8_reachable
    (SafeStep.close s8 key250 bucket250 ClosePath.sweep (by decide) (by decide))

theorem twoWindow_safe_reachable : SafeReachable twoWindowState := safe_s9_reachable

/-- A state with exactly two tasks whose keys differ satisfies INV-8. -/
theorem inv8_of_two_tasks (s : State) (a b : Task)
    (htasks : s.tasks = [a, b]) (hkey : a.key ≠ b.key) : Inv8 s := by
  intro t1 h1 t2 h2 hk
  simp [htasks] at h1 h2
  rcases h1 with rfl | rfl <;> rcases h2 with rfl | rfl
  · rfl
  · exact absurd hk hkey
  · exact absurd hk.symm hkey
  · rfl

theorem twoWindow_inv8 : Inv8 twoWindowState := by
  apply inv8_of_two_tasks twoWindowState taskA taskB
  · decide
  · decide

/-! ### 4. Conditional boundary: deadline-respecting closes preserve INV-8

This is the positive counterpart of the finding. Its proof is the inductive
invariant `Good` in `Specs/Invariant.lean`: every safe step keeps bucket keys
disjoint from emitted task keys, every emitted task is closed no earlier than
its window deadline, and task close times stay in the past. -/

theorem inv8_under_deadline (s : State) (h : SafeReachable s) : Inv8 s :=
  inv8_under_deadline_aux s h

end UberPayment
