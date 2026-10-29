import Specs.Proofs

/-!
Non-vacuity witnesses for the headline theorems.

These are concrete instantiations, not general claims. The G2 trace witness and
the safe two-window witness are both fully proved.
-/
open UberPayment

-- The G2 counterexample state is reachable.
example : Reachable earlyCloseState := earlyClose_trace_reachable

-- ... and it really has two tasks with the same (account, windowStart) key.
example :
    ∃ t1 t2 : Task,
      t1 ∈ earlyCloseState.tasks ∧
      t2 ∈ earlyCloseState.tasks ∧
      t1.key = t2.key ∧
      t1.taskId ≠ t2.taskId ∧
      t1.closedBy = ClosePath.timer ∧
      t2.closedBy = ClosePath.timer ∧
      t1.closedAt < WINDOW_MS ∧
      t2.closedAt < WINDOW_MS :=
  earlyClose_two_tasks_same_window

-- ... and it really violates INV-8.
example : ¬ Inv8 earlyCloseState := earlyClose_breaks_inv8

-- The conditional theorem's hypothesis is inhabited by a state with two
-- completed windows (keys 0 ms and 250 ms).
example : SafeReachable twoWindowState := twoWindow_safe_reachable

-- ... and that state satisfies INV-8 (it is not an empty/vacuous task set).
example : Inv8 twoWindowState := twoWindow_inv8
