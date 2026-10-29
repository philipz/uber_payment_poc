import Specs.Model

/-!
Inductive invariant behind the conditional boundary theorem
`inv8_under_deadline` (proofs phase).

The modelled lifecycle can only add a task by closing a bucket, and can only add
a bucket when no bucket with that window key exists. The extra facts recorded in
`Good` are exactly what the two transitions need beyond INV-8 itself:

* a bucket key never coincides with an already emitted task key;
* every task was emitted no earlier than its window deadline
  (`windowStart + 250 <= closedAt`);
* every emitted task's close time is in the past (`closedAt <= now`).

The first two together rule out recreating a window whose task already exists:
`windowStartOf now = k` forces `now < k + 250`, while a task with key `k` forces
`k + 250 <= closedAt <= now`.
-/

namespace UberPayment

/-- Strengthened invariant preserved by every `SafeStep`. -/
def Good (s : State) : Prop :=
  Inv8 s
  ∧ (∀ b ∈ s.buckets, b.key ∉ s.tasks.map Task.key)
  ∧ (∀ t ∈ s.tasks, t.key.windowStart + WINDOW_MS ≤ t.closedAt)
  ∧ (∀ t ∈ s.tasks, t.closedAt ≤ s.now)

/-- The window containing `n` ends strictly after `n`. -/
theorem windowStartOf_lt (n : Nat) : n < windowStartOf n + WINDOW_MS := by
  unfold windowStartOf WINDOW_MS
  have hmod : n % 250 < 250 := Nat.mod_lt n (by decide)
  have hdiv : n / 250 * 250 + n % 250 = n := by
    rw [Nat.mul_comm]
    exact Nat.div_add_mod n 250
  omega

/-- The bucket returned by `findBucket` is a member of the list. -/
theorem findBucket_mem {bs : List Bucket} {k : WindowKey} {b : Bucket}
    (h : findBucket bs k = some b) : b ∈ bs :=
  List.mem_of_find?_eq_some h

/-- A window key that `ingest` would create cannot already carry a task: the
task's window deadline is in the past, while the new window still contains
`now`. -/
theorem newKey_not_mem_tasks (s : State) (hg : Good s) (account : String) :
    ({ account := account, windowStart := windowStartOf s.now } : WindowKey) ∉
      s.tasks.map Task.key := by
  intro hmem
  rw [List.mem_map] at hmem
  obtain ⟨t, ht, htk⟩ := hmem
  have hclosed : t.key.windowStart + WINDOW_MS ≤ t.closedAt := hg.2.2.1 t ht
  have hpast : t.closedAt ≤ s.now := hg.2.2.2 t ht
  have hw : t.key.windowStart = windowStartOf s.now := by rw [htk]
  have hlt : s.now < windowStartOf s.now + WINDOW_MS := windowStartOf_lt s.now
  omega

theorem good_init : Good initState := by
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro t1 h1
    simp [initState] at h1
  · intro b hb
    simp [initState] at hb
  · intro t ht
    simp [initState] at ht
  · intro t ht
    simp [initState] at ht

theorem good_ingest (s : State) (account : String) (tx : Txn) (hg : Good s) :
    Good (ingest s account tx) := by
  cases hfind : findBucket s.buckets
      ({ account := account, windowStart := windowStartOf s.now } : WindowKey) with
  | none =>
      have hk : ({ account := account, windowStart := windowStartOf s.now } : WindowKey) ∉
          s.tasks.map Task.key := newKey_not_mem_tasks s hg account
      simp only [ingest, hfind]
      refine ⟨hg.1, ?_, hg.2.2.1, hg.2.2.2⟩
      intro b hb
      simp only [List.mem_append, List.mem_singleton] at hb
      rcases hb with hb | rfl
      · exact hg.2.1 b hb
      · simpa using hk
  | some b =>
      simp only [ingest, hfind]
      refine ⟨hg.1, ?_, hg.2.2.1, hg.2.2.2⟩
      intro b' hb'
      rw [List.mem_map] at hb'
      obtain ⟨b0, hb0, rfl⟩ := hb'
      by_cases hbeq : (b0.key == ({ account := account, windowStart := windowStartOf s.now } : WindowKey)) = true
      · simp only [hbeq]
        exact hg.2.1 b0 hb0
      · simp only [hbeq]
        exact hg.2.1 b0 hb0

theorem good_tick (s : State) (d : Nat) (_hd : 0 < d) (hg : Good s) :
    Good { s with now := s.now + d } := by
  refine ⟨hg.1, hg.2.1, hg.2.2.1, ?_⟩
  intro t ht
  exact Nat.le_trans (hg.2.2.2 t ht) (Nat.le_add_right s.now d)

theorem good_close (s : State) (k : WindowKey) (b : Bucket) (path : ClosePath)
    (hb : findBucket s.buckets k = some b)
    (hnow : k.windowStart + WINDOW_MS ≤ s.now) (hg : Good s) :
    Good (closeBucket s k path) := by
  have hbmem : b ∈ s.buckets := findBucket_mem hb
  have hbkey : b.key = k := by
    have hsome := List.find?_some hb
    simpa [beq_iff_eq] using hsome
  have hknot : k ∉ s.tasks.map Task.key := by
    rw [← hbkey]
    exact hg.2.1 b hbmem
  simp only [closeBucket, hb]
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro t1 h1 t2 h2 hkey
    simp only [List.mem_append, List.mem_singleton] at h1 h2
    rcases h1 with h1 | rfl <;> rcases h2 with h2 | rfl
    · exact hg.1 t1 h1 t2 h2 hkey
    · exfalso
      have hmem1 : t1.key ∈ s.tasks.map Task.key := List.mem_map_of_mem h1
      have hk1 : t1.key = k := by simpa using hkey
      exact hknot (hk1 ▸ hmem1)
    · exfalso
      have hmem2 : t2.key ∈ s.tasks.map Task.key := List.mem_map_of_mem h2
      have hk2 : t2.key = k := by simpa using hkey.symm
      exact hknot (hk2 ▸ hmem2)
    · rfl
  · intro b' hb'
    rw [List.mem_filter] at hb'
    obtain ⟨hb'buckets, hb'ne⟩ := hb'
    have hb'ne' : b'.key ≠ k := by
      simpa [bne_iff_ne] using hb'ne
    intro hmem
    rw [List.map_append, List.mem_append] at hmem
    rcases hmem with hmem | hmem
    · exact hg.2.1 b' hb'buckets hmem
    · rw [List.map_singleton, List.mem_singleton] at hmem
      exact hb'ne' (by simpa using hmem)
  · intro t ht
    simp only [List.mem_append, List.mem_singleton] at ht
    rcases ht with ht | rfl
    · exact hg.2.2.1 t ht
    · simpa using hnow
  · intro t ht
    simp only [List.mem_append, List.mem_singleton] at ht
    rcases ht with ht | rfl
    · exact hg.2.2.2 t ht
    · exact Nat.le_refl s.now

/-- Every safe transition preserves `Good`. -/
theorem good_step (s t : State) (hg : Good s) (hs : SafeStep s t) : Good t := by
  cases hs with
  | ingest account tx => exact good_ingest s account tx hg
  | tick d hd => exact good_tick s d hd hg
  | close k b path hb hnow => exact good_close s k b path hb hnow hg

/-- Deadline-respecting runs satisfy INV-8. -/
theorem inv8_under_deadline_aux (s : State) (h : SafeReachable s) : Inv8 s := by
  have hg : Good s := by
    induction h with
    | init => exact good_init
    | step hr hs ih => exact good_step _ _ ih hs
  exact hg.1

end UberPayment
