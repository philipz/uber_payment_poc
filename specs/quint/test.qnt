// Scenario witnesses for specs/quint/model.qnt, instantiated by instances.qnt.
//
// Every witness is a POSITIVE state predicate: it describes the situation the
// corresponding rule/invariant is meant to protect, and it must be reachable
// (quint run --witnesses reports a non-zero trace count). None of them is the
// negation of an invariant, and none holds in init (all require at least one
// action to have happened).
//
// Run with:
//   quint run instances.qnt --main=test --witnesses <name> [...]
module test {
  import config.* from "./instances"
  import model(
    ACCOUNTS = CFG_ACCOUNTS,
    INITIAL_BALANCE = CFG_INITIAL_BALANCE,
    TXN_IDS = CFG_TXN_IDS,
    TXN_ACCOUNT = CFG_TXN_ACCOUNT,
    TXN_OP = CFG_TXN_OP,
    TXN_AMOUNT = CFG_TXN_AMOUNT,
  ).* from "./model"

  // ---------------------------------------------------------------------------
  // INV-1..INV-9 witnesses
  // ---------------------------------------------------------------------------

  val WIT_INV_1_balance_changed: bool =
    ACCOUNTS.exists(a => world.accounts.get(a).balance != INITIAL_BALANCE.get(a))

  val WIT_INV_2_audited_balance: bool =
    ACCOUNTS.exists(a =>
      auditsForAccount(world, a).length() > 0
      and auditsForAccount(world, a).length()
        == processedForAccount(world, a).size())

  val WIT_INV_3_version_advanced: bool =
    ACCOUNTS.exists(a => world.accounts.get(a).version > INITIAL_VERSION)

  val WIT_INV_4_two_distinct_applied: bool = {
    val seen = world.applied.foldl(Set(), (s, row) => s.union(Set(row.txid)))
    world.applied.length() >= 2 and seen.size() == world.applied.length()
  }

  val WIT_INV_5_atomic_multi_commit: bool =
    world.commits.foldl(false, (acc, c) =>
      acc or (c.applied.length() >= 2 and c.auditCountAfter > c.auditCountBefore))

  val WIT_INV_6_committed_audit: bool =
    world.audits.foldl(false, (acc, a) =>
      acc or (a.status == "Committed" and a.microUacSize == 48))

  val WIT_INV_7_noop_commit: bool =
    world.commits.foldl(false, (acc, c) => acc or c.outcome == "noop")

  val WIT_INV_8_two_windows_one_task_each: bool =
    world.tasks.keys().exists(t1 =>
      world.tasks.keys().exists(t2 =>
        t1 != t2
        and world.tasks.get(t1).key != world.tasks.get(t2).key))

  val WIT_INV_9_change_has_audit: bool =
    world.applied.length() > 0
    and world.audits.length() > 0
    and world.commits.foldl(false, (acc, c) =>
      acc or (c.applied.length() > 0 and c.auditCountAfter > c.auditCountBefore))

  // Q9 (owner hint 3): sequenceNumber is the 0-based index in the applied list,
  // not the original batch position. This witness finds a mixed batch where a
  // new txn sat at a later source index but became applied[0] (sequence 0);
  // INV-6 then checks the audit row carries that 0.
  val WIT_Q9_sequence_compacted: bool =
    world.commits.foldl(false, (acc, c) =>
      acc or (c.applied.length() > 0
              and c.applied.length() < c.sourceTxns.length()
              and c.sourceTxns.indices().exists(i =>
                    i > 0 and c.sourceTxns.nth(i).txid == c.applied.nth(0).txid)))

  // ---------------------------------------------------------------------------
  // ACT-1..ACT-8 witnesses
  // ---------------------------------------------------------------------------

  val WIT_ACT_1_aligned_bucket: bool =
    world.buckets.keys().exists(k =>
      k.windowStart == (world.buckets.get(k).openedAt / WINDOW_MS) * WINDOW_MS
      and k.windowStart % WINDOW_MS == 0)

  val WIT_ACT_2_task_from_nonempty_window: bool =
    world.tasks.keys().exists(tid => world.tasks.get(tid).txns.length() > 0)

  val WIT_ACT_3_multi_txn_replay: bool =
    world.commits.foldl(false, (acc, c) => acc or c.applied.length() >= 2)

  // A conflict was observed and at least one commit later succeeded (retry path).
  val WIT_ACT_4_conflict_then_commit: bool =
    world.conflicts.length() > 0
    and world.commits.foldl(false, (acc, c) => acc or c.outcome == "committed")

  val WIT_ACT_5_order_sensitive_commit: bool =
    world.commits.foldl(false, (acc, c) =>
      acc or (c.applied.length() >= 2
              and c.applied.foldl(false, (seenCredit, t) =>
                    seenCredit or t.op == OP_CREDIT)
              and c.applied.foldl(false, (seenDebit, t) =>
                    seenDebit or t.op == OP_DEBIT)))

  // A commit whose source txids were already processed at read time applied
  // nothing (safe retry after 504 / duplicate delivery / cache expiry).
  val WIT_ACT_6_retry_is_noop: bool =
    world.commits.foldl(false, (acc, c) =>
      acc or (c.applied.length() == 0
              and c.sourceTxns.length() > 0
              and c.sourceTxns.foldl(true, (allSeen, t) =>
                    allSeen and c.processedBefore.contains(t.txid))))

  // The timer path can close before windowStart+250 (ACT-7 / Q1 early close).
  val WIT_ACT_7_early_timer_close: bool =
    world.tasks.keys().exists(tid => {
      val t = world.tasks.get(tid)
      t.closedBy == "timer" and t.closedAt < t.key.windowStart + WINDOW_MS
    })

  // The sweeper closes only after the deadline.
  val WIT_ACT_7_sweep_after_deadline: bool =
    world.tasks.keys().exists(tid => {
      val t = world.tasks.get(tid)
      t.closedBy == "sweep" and t.closedAt >= t.key.windowStart + WINDOW_MS
    })

  // Two workers read the same task at the same snapshot version (ACT-8 / Q13).
  val WIT_ACT_8_two_reads_same_snapshot: bool =
    world.reads.indices().exists(i =>
      world.reads.indices().exists(j =>
        i != j
        and world.reads.nth(i).taskId == world.reads.nth(j).taskId
        and world.reads.nth(i).worker != world.reads.nth(j).worker
        and world.reads.nth(i).version == world.reads.nth(j).version))
}
