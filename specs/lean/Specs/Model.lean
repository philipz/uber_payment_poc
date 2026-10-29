/-
Lean model of the batched (250 ms window) ingress lifecycle of
philipz/uber_payment_poc, restricted to the decision that G2 sent to Lean:
the INV-8 violation `inv8-early-close` (`specs/quint/TRIAGE.md:10`,
`specs/quint/REPORT.md:146-169`).

Rule source of record: `specs/quint/RULES.md` (G1-confirmed v2, read-only).
This model deliberately keeps only the window/bucket/task lifecycle. The worker,
OCC, replay and audit machinery cannot change whether a `(account, windowStart)`
key receives a second task: a task, once created, is never destroyed, and INV-8
is a property of the task set alone. See `MODEL-MAP.md` for the abstraction
ledger and the source `file:line` map.

Code shape modelled (evidence, not a second rule source):
  * `ACCUMULATE_LUA`: W = floor(RedisTime/250)*250; append to the existing bucket
    for W or create it (`src/shared/lua.ts:9-25`).
  * `CLOSE_ONE_LUA`: LRANGE -> ZREM -> DEL, then push one task for a non-empty
    bucket; it does NOT re-read Redis TIME (`src/shared/lua.ts:30-53`).
  * `SWEEP_LUA`: selects buckets whose score (windowStart+250) is <= Redis TIME
    (`src/shared/lua.ts:74-102`).
  * creator timer: `setTimeout(closeWindow(bucket), msUntilClose)`; the delay is
    computed from the Lua clock (`src/services/batch-creator/index.ts:232-236`).
-/
namespace UberPayment

/-- `(accountId, windowStart)`, the Redis bucket identity. -/
structure WindowKey where
  account : String
  windowStart : Nat
  deriving DecidableEq, Repr

/-- A transaction as far as window lifecycle is concerned. `op`/`amount` are
kept so the concrete G2 trace is recognisable; they do not influence INV-8. -/
structure Txn where
  txid : String
  op : Nat
  amount : Nat
  deriving DecidableEq, Repr

/-- One Redis list `batch:{windowStart}:{accountId}`. -/
structure Bucket where
  key : WindowKey
  txns : List Txn
  openedAt : Nat
  deriving DecidableEq, Repr

/-- The two closing paths: the creator timer (`CLOSE_ONE_LUA`) and the sweeper
(`SWEEP_LUA`). They differ only in whether Redis TIME is re-checked. -/
inductive ClosePath where
  | timer
  | sweep
  deriving DecidableEq, Repr

/-- One entry pushed to `tasks:global`. `taskId` is the model's monotone counter. -/
structure Task where
  taskId : Nat
  key : WindowKey
  txns : List Txn
  closedAt : Nat
  closedBy : ClosePath
  deriving DecidableEq, Repr

/-- `now` is Redis TIME (ms); `buckets` and `tasks` are the observable sets. -/
structure State where
  now : Nat
  buckets : List Bucket
  tasks : List Task
  nextTaskId : Nat
  deriving DecidableEq, Repr

/-- `WINDOW_MS = 250` (`src/shared/keys.ts:7`). -/
def WINDOW_MS : Nat := 250

/-- `floor(now/windowMs)*windowMs` (`src/shared/lua.ts:13-15`). -/
def windowStartOf (now : Nat) : Nat := (now / WINDOW_MS) * WINDOW_MS

def findBucket (bs : List Bucket) (k : WindowKey) : Option Bucket :=
  bs.find? (fun b => b.key == k)

/-- `ACCUMULATE_LUA`: append to the bucket for the current window, creating the
bucket (and arming the timer in the real system) on first use. -/
def ingest (s : State) (account : String) (t : Txn) : State :=
  let k : WindowKey := { account := account, windowStart := windowStartOf s.now }
  match findBucket s.buckets k with
  | some _ =>
      { s with
        buckets := s.buckets.map (fun b =>
          if b.key == k then { b with txns := b.txns ++ [t] } else b) }
  | none =>
      { s with
        buckets := s.buckets ++ [{ key := k, txns := [t], openedAt := s.now }] }

/-- `CLOSE_ONE_LUA` / `SWEEP_LUA`: atomically remove the bucket and, when it was
non-empty, push exactly one task carrying its transactions. The empty-bucket
case cannot arise: buckets are created with one transaction and removed in the
same step. -/
def closeBucket (s : State) (k : WindowKey) (path : ClosePath) : State :=
  match findBucket s.buckets k with
  | none => s
  | some b =>
      { now := s.now
        buckets := s.buckets.filter (fun x => x.key != k)
        tasks := s.tasks ++
          [{ taskId := s.nextTaskId
             key := k
             txns := b.txns
             closedAt := s.now
             closedBy := path }]
        nextTaskId := s.nextTaskId + 1 }

def initState : State :=
  { now := 0, buckets := [], tasks := [], nextTaskId := 0 }

/-- INV-8 (`specs/quint/RULES.md:46`): every `(accountId, windowStart)` has at
most one batch/task: any two tasks with the same key are the same task. -/
def Inv8 (s : State) : Prop :=
  ∀ t1 ∈ s.tasks, ∀ t2 ∈ s.tasks, t1.key = t2.key → t1 = t2

/-- Concrete update relation mirroring the modelled transitions. -/
inductive Step : State → State → Prop where
  | ingest (s : State) (account : String) (t : Txn) :
      Step s (ingest s account t)
  | tick (s : State) (d : Nat) (hd : 0 < d) :
      Step s { s with now := s.now + d }
  | timerClose (s : State) (k : WindowKey) (b : Bucket)
      (hb : findBucket s.buckets k = some b)
      (hnow : k.windowStart ≤ s.now) :
      Step s (closeBucket s k ClosePath.timer)
  | sweep (s : State) (k : WindowKey) (b : Bucket)
      (hb : findBucket s.buckets k = some b)
      (hnow : k.windowStart + WINDOW_MS ≤ s.now) :
      Step s (closeBucket s k ClosePath.sweep)

/-- Reachability under the as-is transition relation, including the timer path
that does not re-check the deadline (RULES.md ACT-7 / Q1). -/
inductive Reachable : State → Prop where
  | init : Reachable initState
  | step {s t : State} (h : Reachable s) (hs : Step s t) : Reachable t

/-- The same lifecycle with both closing paths required to respect
`windowStart + WINDOW_MS`, i.e. the boundary condition under which RULES.md
states INV-8. This is the "no early close" environment. -/
inductive SafeStep : State → State → Prop where
  | ingest (s : State) (account : String) (t : Txn) :
      SafeStep s (ingest s account t)
  | tick (s : State) (d : Nat) (hd : 0 < d) :
      SafeStep s { s with now := s.now + d }
  | close (s : State) (k : WindowKey) (b : Bucket) (path : ClosePath)
      (hb : findBucket s.buckets k = some b)
      (hnow : k.windowStart + WINDOW_MS ≤ s.now) :
      SafeStep s (closeBucket s k path)

inductive SafeReachable : State → Prop where
  | init : SafeReachable initState
  | step {s t : State} (h : SafeReachable s) (hs : SafeStep s t) : SafeReachable t

/-! ## Concrete states from the G2 counterexample trace

The trace `specs/quint/traces/inv8-early-close.itf.json` (seed 2) has four
states: ingest `tx-4` at `now=0`; close that bucket with the timer at `now=0`;
ingest `tx-3` at `now=0` (which recreates the same window); close again with the
timer at `now=0`. Both closes happen 250 ms before the deadline. -/

def key0 : WindowKey := { account := "hot-account-1", windowStart := 0 }

def tx4 : Txn := { txid := "tx-4", op := 4, amount := 4 }
def tx3 : Txn := { txid := "tx-3", op := 3, amount := 3 }

def bucket1 : Bucket := { key := key0, txns := [tx4], openedAt := 0 }
def bucket3 : Bucket := { key := key0, txns := [tx3], openedAt := 0 }

def task0 : Task :=
  { taskId := 0, key := key0, txns := [tx4], closedAt := 0, closedBy := ClosePath.timer }
def task1 : Task :=
  { taskId := 1, key := key0, txns := [tx3], closedAt := 0, closedBy := ClosePath.timer }

def s1 : State := ingest initState "hot-account-1" tx4
def s2 : State := closeBucket s1 key0 ClosePath.timer
def s3 : State := ingest s2 "hot-account-1" tx3
def s4 : State := closeBucket s3 key0 ClosePath.timer

/-- The state asserted by the G2 counterexample. -/
def earlyCloseState : State := s4

/-! ## Concrete states for a safe (deadline-respecting) two-window run

Used as the non-vacuity witness for the conditional theorem: two tasks, but in
different windows. Ingest at 0, sweep at 250, ingest at 250, sweep at 500. -/

def key250 : WindowKey := { account := "hot-account-1", windowStart := 250 }
def taskA : Task :=
  { taskId := 0, key := key0, txns := [tx4], closedAt := 250, closedBy := ClosePath.sweep }
def taskB : Task :=
  { taskId := 1, key := key250, txns := [tx3], closedAt := 500, closedBy := ClosePath.sweep }
def bucket250 : Bucket := { key := key250, txns := [tx3], openedAt := 250 }

def s5 : State := { s1 with now := 250 }
def s6 : State := closeBucket s5 key0 ClosePath.sweep
def s7 : State := ingest s6 "hot-account-1" tx3
def s8 : State := { s7 with now := 500 }
def s9 : State := closeBucket s8 key250 ClosePath.sweep

/-- Two completed windows, both closed at or after their deadline. -/
def twoWindowState : State := s9

end UberPayment
