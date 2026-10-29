/-
Axiom audit for the headline theorems (Rule 3 guardrail).

Run from the Lean project directory:

    export PATH="$HOME/.elan/bin:$PATH"
    lake env lean Audit.lean

Proofs phase: all three lines pass the allowlist (propext, Classical.choice,
Quot.sound, or "does not depend on any axioms").
-/
import Specs

#print axioms UberPayment.earlyClose_two_tasks_same_window
#print axioms UberPayment.inv8_refuted_by_early_close
#print axioms UberPayment.inv8_under_deadline
