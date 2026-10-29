// Quint model of philipz/uber_payment_poc (batched path only), phase 2.
//
// Source of truth for every rule in this file is specs/quint/RULES.md
// (G1-confirmed v2). It is a read-only input: this model must not add, widen,
// or "fix" those rules. Code references below are evidence for the *shape* of
// the model (what the implementation actually does), not a second rule source.
//
// Scope: batched ingress -> 250ms window bucket -> task -> worker attempt ->
// Postgres OCC commit. Out of scope (RULES.md OUT-1..OUT-12): naive mode, SSE
// order, cross-account txid reuse, multi-creator, overdraft policy, Tentative
// audit, finalize liveness, metrics.
module model {

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  type AccountId = str
  type TxnId = str
  type WorkerId = int

  // operation code mirrors OperationType: 1 Credit, 2 Debit, 3 Authorize, 4 Release
  // (src/shared/types.ts:4-9). Kept as int so the concrete instance in
  // instances.qnt can bind consts without importing enum constructors.
  type Op = int

  type WindowKey = { account: AccountId, windowStart: int }

  type Txn = { txid: TxnId, account: AccountId, op: Op, amount: int }

  type Bucket = { txns: List[Txn], openedAt: int }

  type Task = {
    taskId: int,
    key: WindowKey,
    txns: List[Txn],
    closedAt: int,
    closedBy: str, // "timer" (CLOSE_ONE) or "sweep" (SWEEP_LUA)
  }

  type AttemptPhase = Idle | Reading | Ready

  // One worker's local DB-transaction snapshot. `applied`/`balances` are the
  // dedupe + replay result computed from the snapshot; they are only written to
  // the DB if the OCC version check still matches at commit time.
  type Attempt = {
    taskId: int,
    phase: AttemptPhase,
    snapshotVersion: int,
    snapshotBalance: int,
    snapshotProcessed: Set[TxnId],
    applied: List[Txn],
    balances: List[int],
    retries: int,
  }

  type Account = { balance: int, version: int }

  type ProcessedRow = {
    account: AccountId,
    txid: TxnId,
    appliedVersion: int,
    balanceAfter: int,
  }

  // One row per (balance-changing) applied transaction; instrumentation used to
  // state INV-1/INV-4/INV-6. The real ledger has no such table, but every row here
  // corresponds 1:1 to a processed_transactions row written in the same commit.
  type AppliedRow = {
    account: AccountId,
    txid: TxnId,
    op: Op,
    amount: int,
    commitVersion: int,
    sequenceNumber: int,
    balanceAfter: int,
  }

  type AuditRow = {
    account: AccountId,
    txid: TxnId,
    op: Op,
    amount: int,
    sequenceNumber: int,
    accountVersion: int,
    status: str,
    microUacSize: int,
  }

  // Record of one DB COMMIT attempt outcome. `outcome` is "committed" (at least
  // one new txn applied) or "noop" (all source txids were already processed).
  // Counts are per-account for audit, global for finalize.
  type CommitRow = {
    account: AccountId,
    taskId: int,
    beforeBalance: int,
    afterBalance: int,
    beforeVersion: int,
    afterVersion: int,
    applied: List[Txn],
    balancesAfter: List[int],
    sourceTxns: List[Txn],
    processedBefore: Set[TxnId],
    auditCountBefore: int,
    auditCountAfter: int,
    finalizeCountBefore: int,
    finalizeCountAfter: int,
    outcome: str,
  }

  type FinalizeRow = { taskId: int, account: AccountId, count: int }

  type ReadRow = {
    worker: WorkerId,
    taskId: int,
    version: int,
    balance: int,
    appliedCount: int,
    at: int,
  }

  type ConflictRow = {
    worker: WorkerId,
    taskId: int,
    snapshotVersion: int,
    actualVersion: int,
    at: int,
  }

  type World = {
    now: int, // Redis TIME, ms
    buckets: WindowKey -> Bucket,
    accounts: AccountId -> Account,
    processed: TxnId -> ProcessedRow,
    applied: List[AppliedRow],
    audits: List[AuditRow],
    commits: List[CommitRow],
    finalizes: List[FinalizeRow],
    tasks: int -> Task,
    queued: Set[int],
    attempts: WorkerId -> Attempt,
    nextTaskId: int,
    reads: List[ReadRow],
    conflicts: List[ConflictRow],
  }

  // ---------------------------------------------------------------------------
  // Constants
  //
  // Every const carries a domain_justification: either the exact code check, or
  // "program does not restrict" plus the boundary values the instance covers.
  // No assume/assert below narrows a domain that the program leaves open.
  // ---------------------------------------------------------------------------

  // domain_justification: accountId is only checked against /^[A-Za-z0-9_-]+$/
  // (src/services/batch-creator/index.ts:68,182-186); unknown accounts are 404
  // and never applied (src/services/batch-process/index.ts:120-123,207-209).
  // db/init.sql:33-35 seeds one row, hot-account-1. The instance samples that
  // single seeded account; this is a sampling choice, not a program bound.
  const ACCOUNTS: Set[AccountId]

  // domain_justification: db/init.sql:6 defaults balance to 0 and :33-35 seeds
  // hot-account-1 with balance 0. The program does not restrict initial balance.
  const INITIAL_BALANCE: AccountId -> int

  // domain_justification: transactionId must be a non-empty string
  // (src/services/batch-creator/index.ts:132); no other program bound. The
  // instance samples five ids, including ids of every operation type.
  const TXN_IDS: Set[TxnId]

  // domain_justification: ENV-1 in RULES.md fixes (account, op, amount) per
  // txid. The program itself does NOT re-validate the payload on retry
  // (src/services/batch-process/index.ts:128-143); this is an upstream premise,
  // exactly as RULES.md states, not an assumption invented by the model.
  const TXN_ACCOUNT: TxnId -> AccountId
  const TXN_OP: TxnId -> Op
  const TXN_AMOUNT: TxnId -> int

  // domain_justification: window length is the constant 250 in
  // src/shared/keys.ts:6; the Lua uses floor(now/windowMs)*windowMs
  // (src/shared/lua.ts:13-15).
  pure val WINDOW_MS: int = 250

  // domain_justification: src/services/batch-process/index.ts:37 MAX_OCC_RETRIES=20.
  pure val MAX_OCC_RETRIES: int = 20

  // domain_justification: docker-compose runs three workers; RULES.md Q13 requires
  // at least two interleavable attempts. Two is the minimal domain that reaches
  // concurrent-attempt states; it is a sampling bound for state-space size, not a
  // program limit.
  pure val WORKERS: Set[WorkerId] = Set(1, 2)

  // domain_justification: Redis TIME is an unrestricted millisecond clock
  // (src/shared/lua.ts:13-14). These deltas sample that clock and include 1ms and
  // the 249/250ms window boundary; repeated steps can reach every window offset.
  pure val TIME_DELTAS: Set[int] = Set(1, 50, 100, 249, 250, 500)

  // Operation codes; domain is exactly {1,2,3,4} per src/shared/types.ts:4-9 and
  // the input check at src/services/batch-creator/index.ts:133.
  pure val OP_CREDIT: Op = 1
  pure val OP_DEBIT: Op = 2
  pure val OP_AUTHORIZE: Op = 3
  pure val OP_RELEASE: Op = 4

  // db/init.sql:6,33-35: every account row starts at version 0.
  pure val INITIAL_VERSION: int = 0

  // ---------------------------------------------------------------------------
  // Pure functions
  // ---------------------------------------------------------------------------

  pure def opValid(op: Op): bool = op >= 1 and op <= 4

  // src/shared/operations.ts:5-18. Unknown op throws in code; input validation
  // rejects it earlier (creator:133), so ENV_op_valid checks it never appears.
  pure def signedAmount(op: Op, amount: int): int =
    if (op == OP_CREDIT) amount
    else if (op == OP_DEBIT) -amount
    else if (op == OP_AUTHORIZE) -amount
    else if (op == OP_RELEASE) amount
    else 0

  pure def txnOf(txid: TxnId): Txn = {
    txid: txid,
    account: TXN_ACCOUNT.get(txid),
    op: TXN_OP.get(txid),
    amount: TXN_AMOUNT.get(txid),
  }

  // src/shared/operations.ts:20-34: drop already-processed txids, then keep the
  // first occurrence in arrival order. The list order is load-bearing (ACT-5).
  pure def dedupe(txns: List[Txn], already: Set[TxnId]): List[Txn] =
    txns.select(t => not(already.contains(t.txid))).foldl({ seen: Set(), out: List() },
      (acc, t) =>
        if (acc.seen.contains(t.txid)) acc
        else { seen: acc.seen.union(Set(t.txid)), out: acc.out.append(t) }).out

  // src/shared/operations.ts:41-55: replay in list order, one balance per step.
  pure def replayBalances(balance: int, txns: List[Txn]): List[int] =
    txns.foldl({ running: balance, out: List() },
      (acc, t) => {
        val nb = acc.running + signedAmount(t.op, t.amount)
        { running: nb, out: acc.out.append(nb) }
      }).out

  pure def removeBucket(m: WindowKey -> Bucket, k: WindowKey): WindowKey -> Bucket =
    m.keys().filter(x => x != k).mapBy(x => m.get(x))

  pure def auditsForAccount(w: World, account: AccountId): List[AuditRow] =
    w.audits.select(a => a.account == account)

  pure def appliedForAccount(w: World, account: AccountId): List[AppliedRow] =
    w.applied.select(a => a.account == account)

  pure def processedForAccount(w: World, account: AccountId): Set[TxnId] =
    w.processed.keys().filter(txid => w.processed.get(txid).account == account)

  pure def sumSignedApplied(w: World, account: AccountId): int =
    appliedForAccount(w, account).foldl(0, (acc, row) =>
      acc + signedAmount(row.op, row.amount))

  pure def nonNoopCommits(w: World, account: AccountId): int =
    w.commits.select(c => c.account == account and c.applied.length() > 0).length()

  pure def mkApplied(
    account: AccountId,
    version: int,
    txns: List[Txn],
    balances: List[int],
  ): List[AppliedRow] =
    txns.foldl({ i: 0, out: List() },
      (acc, t) => {
        val row = {
          account: account,
          txid: t.txid,
          op: t.op,
          amount: t.amount,
          commitVersion: version,
          sequenceNumber: acc.i,
          balanceAfter: balances.nth(acc.i),
        }
        { i: acc.i + 1, out: acc.out.append(row) }
      }).out

  pure def mkAudits(
    account: AccountId,
    version: int,
    txns: List[Txn],
  ): List[AuditRow] =
    txns.foldl({ i: 0, out: List() },
      (acc, t) => {
        val row = {
          account: account,
          txid: t.txid,
          op: t.op,
          amount: t.amount,
          sequenceNumber: acc.i,
          accountVersion: version,
          status: "Committed",
          microUacSize: 48,
        }
        { i: acc.i + 1, out: acc.out.append(row) }
      }).out

  // ON CONFLICT (transaction_id) DO NOTHING: never overwrite an existing row.
  pure def addProcessed(
    m: TxnId -> ProcessedRow,
    account: AccountId,
    version: int,
    txns: List[Txn],
    balances: List[int],
  ): TxnId -> ProcessedRow =
    txns.foldl({ i: 0, m: m },
      (acc, t) => {
        val row = {
          account: account,
          txid: t.txid,
          appliedVersion: version,
          balanceAfter: balances.nth(acc.i),
        }
        {
          i: acc.i + 1,
          m: if (acc.m.keys().contains(t.txid)) acc.m else acc.m.put(t.txid, row),
        }
      }).m

  pure val IDLE_ATTEMPT: Attempt = {
    taskId: -1,
    phase: Idle,
    snapshotVersion: 0,
    snapshotBalance: 0,
    snapshotProcessed: Set(),
    applied: List(),
    balances: List(),
    retries: 0,
  }

  pure def initWorld: World = {
    now: 0,
    buckets: Map(),
    accounts: ACCOUNTS.mapBy(a => {
      balance: INITIAL_BALANCE.get(a),
      version: INITIAL_VERSION,
    }),
    processed: Map(),
    applied: List(),
    audits: List(),
    commits: List(),
    finalizes: List(),
    tasks: Map(),
    queued: Set(),
    attempts: WORKERS.mapBy(_ => IDLE_ATTEMPT),
    nextTaskId: 0,
    reads: List(),
    conflicts: List(),
  }

  // ACCUMULATE_LUA: W = floor(RedisTime/250)*250; first txn creates the bucket and
  // arms the timer; every txn is appended in arrival order.
  pure def ingestTxn(w: World, txid: TxnId): World = {
    val t = txnOf(txid)
    val ws = (w.now / WINDOW_MS) * WINDOW_MS
    val k = { account: t.account, windowStart: ws }
    val bucket =
      if (w.buckets.keys().contains(k)) w.buckets.get(k)
      else { txns: List(), openedAt: w.now }
    val bucket2 = { ...bucket, txns: bucket.txns.append(t) }
    { ...w, buckets: w.buckets.put(k, bucket2) }
  }

  // CLOSE_ONE_LUA / SWEEP_LUA: atomically LRANGE -> ZREM -> DEL, then push exactly
  // one task for a non-empty bucket. Callers guard that the bucket exists.
  pure def closeBucket(w: World, k: WindowKey, by: str): World = {
    val bucket = w.buckets.get(k)
    val tid = w.nextTaskId
    val task = {
      taskId: tid,
      key: k,
      txns: bucket.txns,
      closedAt: w.now,
      closedBy: by,
    }
    {
      ...w,
      buckets: removeBucket(w.buckets, k),
      tasks: w.tasks.put(tid, task),
      queued: w.queued.union(Set(tid)),
      nextTaskId: tid + 1,
    }
  }

  // Worker transaction: BEGIN -> SELECT account -> SELECT processed -> dedupe ->
  // replay. No DB write yet; the snapshot is what OCC will later validate.
  pure def readAttempt(w: World, worker: WorkerId): World = {
    val a = w.attempts.get(worker)
    val task = w.tasks.get(a.taskId)
    val account = task.key.account
    val acct = w.accounts.get(account)
    val already = w.processed.keys()
    val newApplied = dedupe(task.txns, already)
    val balances = replayBalances(acct.balance, newApplied)
    val a2 = {
      ...a,
      phase: Ready,
      snapshotVersion: acct.version,
      snapshotBalance: acct.balance,
      snapshotProcessed: already,
      applied: newApplied,
      balances: balances,
    }
    val read = {
      worker: worker,
      taskId: a.taskId,
      version: acct.version,
      balance: acct.balance,
      appliedCount: newApplied.length(),
      at: w.now,
    }
    { ...w, attempts: w.attempts.put(worker, a2), reads: w.reads.append(read) }
  }

  // Successful COMMIT with >=1 new txn: OCC update + processed + audit + finalize
  // notification are one atomic step (src/services/batch-process/index.ts:155-195,
  // 242-254).
  pure def commitAttempt(w: World, worker: WorkerId, task: Task, a: Attempt): World = {
    val account = task.key.account
    val before = w.accounts.get(account)
    val newVersion = before.version + 1
    val newBalance = a.balances.nth(a.balances.length() - 1)
    val auditBefore = auditsForAccount(w, account).length()
    val finalizeBefore = w.finalizes.length()
    val commit = {
      account: account,
      taskId: task.taskId,
      beforeBalance: before.balance,
      afterBalance: newBalance,
      beforeVersion: before.version,
      afterVersion: newVersion,
      applied: a.applied,
      balancesAfter: a.balances,
      sourceTxns: task.txns,
      processedBefore: a.snapshotProcessed,
      auditCountBefore: auditBefore,
      auditCountAfter: auditBefore + a.applied.length(),
      finalizeCountBefore: finalizeBefore,
      finalizeCountAfter: finalizeBefore + 1,
      outcome: "committed",
    }
    {
      ...w,
      accounts: w.accounts.put(account, {
        balance: newBalance,
        version: newVersion,
      }),
      processed: addProcessed(w.processed, account, newVersion, a.applied, a.balances),
      applied: w.applied.concat(mkApplied(account, newVersion, a.applied, a.balances)),
      audits: w.audits.concat(mkAudits(account, newVersion, a.applied)),
      commits: w.commits.append(commit),
      finalizes: w.finalizes.append({
        taskId: task.taskId,
        account: account,
        count: a.applied.length(),
      }),
      attempts: w.attempts.put(worker, IDLE_ATTEMPT),
    }
  }

  // COMMIT when appliedTxns.length === 0: no UPDATE, no version bump, no audit,
  // no finalize; response is the current account state (index.ts:145-150).
  pure def noopAttempt(w: World, worker: WorkerId, task: Task, a: Attempt): World = {
    val account = task.key.account
    val before = w.accounts.get(account)
    val auditBefore = auditsForAccount(w, account).length()
    val finalizeBefore = w.finalizes.length()
    val commit = {
      account: account,
      taskId: task.taskId,
      beforeBalance: before.balance,
      afterBalance: before.balance,
      beforeVersion: before.version,
      afterVersion: before.version,
      applied: List(),
      balancesAfter: List(),
      sourceTxns: task.txns,
      processedBefore: a.snapshotProcessed,
      auditCountBefore: auditBefore,
      auditCountAfter: auditBefore,
      finalizeCountBefore: finalizeBefore,
      finalizeCountAfter: finalizeBefore,
      outcome: "noop",
    }
    { ...w, commits: w.commits.append(commit), attempts: w.attempts.put(worker, IDLE_ATTEMPT) }
  }

  // UPDATE ... WHERE version = v affected 0 rows -> ROLLBACK, re-read and retry.
  pure def conflictAttempt(w: World, worker: WorkerId, task: Task, a: Attempt): World = {
    val account = task.key.account
    val actual = w.accounts.get(account).version
    val record = {
      worker: worker,
      taskId: task.taskId,
      snapshotVersion: a.snapshotVersion,
      actualVersion: actual,
      at: w.now,
    }
    val a2 = { ...a, phase: Reading, retries: a.retries + 1 }
    {
      ...w,
      attempts: w.attempts.put(worker, a2),
      conflicts: w.conflicts.append(record),
    }
  }

  // After MAX_OCC_RETRIES the attempt gives up (HTTP 409 path, index.ts:276).
  pure def giveUpAttempt(w: World, worker: WorkerId): World =
    { ...w, attempts: w.attempts.put(worker, IDLE_ATTEMPT) }

  // Reclaim moves a task back to the global queue while the stale attempt may
  // still be running. This is the only way the model can reach two concurrent
  // attempts for one task (RULES.md ENV-3 / Q13).
  pure def reclaimAttempt(w: World, worker: WorkerId): World = {
    val a = w.attempts.get(worker)
    { ...w, queued: w.queued.union(Set(a.taskId)) }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var world: World

  // ---------------------------------------------------------------------------
  // Invariants (RULES.md INV-1..INV-9) and rule checks (ACT-1..ACT-8)
  // ---------------------------------------------------------------------------

  // INV-1: balance = initial_balance + sum of signed amounts of applied txns.
  val INV_1_conservation: bool =
    ACCOUNTS.forall(a =>
      world.accounts.get(a).balance
        == INITIAL_BALANCE.get(a) + sumSignedApplied(world, a))

  // INV-2: per account, count(audit) = count(processed) = count(applied txns).
  val INV_2_counts: bool =
    ACCOUNTS.forall(a =>
      auditsForAccount(world, a).length()
          == processedForAccount(world, a).size()
        and processedForAccount(world, a).size()
          == appliedForAccount(world, a).length())

  // INV-3: version = initial version + non-noop commits; each commit bumps by 1.
  val INV_3_version: bool =
    ACCOUNTS.forall(a =>
      world.accounts.get(a).version == INITIAL_VERSION + nonNoopCommits(world, a))
    and world.commits.foldl(true, (acc, c) =>
      acc and (c.applied.length() == 0 or c.afterVersion == c.beforeVersion + 1))

  // INV-4: each transactionId is applied at most once, even across redelivery,
  // OCC retry and re-submission after the result cache expires.
  val INV_4_txid_once: bool = {
    val seen = world.applied.foldl(Set(), (s, row) => s.union(Set(row.txid)))
    seen.size() == world.applied.length()
  }

  // INV-5: atomicity -- ledger, processed and audit are written together, so
  // every applied row has a matching processed row and no processed row is
  // orphaned; a commit's audit/finalize deltas are exactly what it applied.
  val INV_5_atomic: bool =
    world.applied.foldl(true, (acc, row) =>
      acc and world.processed.keys().contains(row.txid)
      and world.processed.get(row.txid).account == row.account
      and world.processed.get(row.txid).appliedVersion == row.commitVersion
      and world.processed.get(row.txid).balanceAfter == row.balanceAfter)
    and world.processed.keys().size() == world.applied.length()
    and world.commits.foldl(true, (acc, c) =>
      acc
      and c.auditCountAfter == c.auditCountBefore + c.applied.length()
      and c.finalizeCountAfter
        == c.finalizeCountBefore + (if (c.applied.length() > 0) 1 else 0))

  // INV-6: each applied txn has exactly one 48-byte Committed audit row whose
  // operation/amount/version/sequence match the applied transaction.
  val INV_6_audit: bool =
    world.applied.foldl(true, (acc, row) => {
      val rows =
        world.audits.select(a => a.account == row.account and a.txid == row.txid)
      acc and (if (rows.length() == 1) {
        val a = rows.head()
        all {
          a.status == "Committed",
          a.microUacSize == 48,
          a.op == row.op,
          a.amount == row.amount,
          a.accountVersion == row.commitVersion,
          a.sequenceNumber == row.sequenceNumber,
        }
      } else false)
    })

  // INV-7: an all-duplicate (no-op) batch changes no balance/version/audit and
  // produces no finalize notification.
  val INV_7_noop: bool =
    world.commits.foldl(true, (acc, c) =>
      acc and {
        (c.applied.length() > 0)
        or all {
          c.outcome == "noop",
          c.beforeBalance == c.afterBalance,
          c.beforeVersion == c.afterVersion,
          c.auditCountBefore == c.auditCountAfter,
          c.finalizeCountBefore == c.finalizeCountAfter,
        }
      })

  // INV-8: each (accountId, windowStart) creates at most one batch/task.
  val INV_8_single_batch: bool =
    world.tasks.keys().forall(t1 =>
      world.tasks.keys().forall(t2 =>
        (t1 == t2)
        or (world.tasks.get(t1).key != world.tasks.get(t2).key)))

  // INV-9: no state in which a balance changed without a corresponding audit.
  val INV_9_no_unaccounted: bool =
    world.commits.foldl(true, (acc, c) =>
      acc and (c.applied.length() == 0 or c.auditCountAfter > c.auditCountBefore))
    and world.applied.foldl(true, (acc, row) =>
      acc and world.audits.select(a =>
        a.account == row.account and a.txid == row.txid).length() > 0)

  // ACT-1: windowStart is floor(RedisTimeMs/250)*250, and every bucket/task key
  // is aligned to the 250ms grid.
  val ACT_1_window_alignment: bool =
    world.buckets.keys().forall(k =>
      k.windowStart == (world.buckets.get(k).openedAt / WINDOW_MS) * WINDOW_MS
      and k.windowStart % WINDOW_MS == 0)
    and world.tasks.keys().forall(tid =>
      world.tasks.get(tid).key.windowStart % WINDOW_MS == 0)

  // ACT-2: closing a bucket yields one task carrying the bucket's non-empty
  // transaction list. (Empty buckets cannot exist: the bucket is created by the
  // first RPUSH, lua.ts:18-19, and closeBucket removes it in the same step.)
  // "bucket key is absent" is NOT a state invariant: after an early close the
  // same (account,windowStart) can legitimately be re-created (Q1), which is what
  // INV-8 catches instead.
  val ACT_2_close_task: bool =
    world.tasks.keys().forall(tid => {
      val t = world.tasks.get(tid)
      all {
        t.txns.length() > 0,
        t.closedAt >= t.key.windowStart,
      }
    })

  // ACT-3 / ACT-5: replay uses the deduped arrival-order list and the per-step
  // balances are the running signed sums in that order.
  val ACT_3_replay_order: bool =
    world.commits.foldl(true, (acc, c) =>
      acc
      and c.applied == dedupe(c.sourceTxns, c.processedBefore)
      and c.balancesAfter == replayBalances(c.beforeBalance, c.applied)
      and (c.applied.length() == 0
           or c.balancesAfter.nth(c.balancesAfter.length() - 1) == c.afterBalance))

  // ACT-4: a successful non-noop commit advances version by exactly one; a
  // conflicting attempt saw an actual version different from its snapshot.
  val ACT_4_occ: bool =
    world.commits.foldl(true, (acc, c) =>
      acc and (c.applied.length() == 0 or c.afterVersion == c.beforeVersion + 1))
    and world.conflicts.foldl(true, (acc, c) =>
      acc and c.snapshotVersion != c.actualVersion)

  // ACT-6: a retry is safe -- if every source txid was already processed at read
  // time, the commit applies nothing.
  val ACT_6_retry_safe: bool =
    world.commits.foldl(true, (acc, c) =>
      acc and ((c.sourceTxns.select(t => not(c.processedBefore.contains(t.txid))).length() > 0)
               or (c.applied.length() == 0)))

  // ACT-7: the sweeper re-checks Redis TIME before closing (closedAt >= deadline);
  // the timer path does not (closedAt may be before the deadline -- deliberately
  // reachable, Q1).
  val ACT_7_close_paths: bool =
    world.tasks.keys().forall(tid => {
      val t = world.tasks.get(tid)
      if (t.closedBy == "sweep") t.closedAt >= t.key.windowStart + WINDOW_MS
      else if (t.closedBy == "timer") t.closedAt >= t.key.windowStart
      else false
    })

  // ACT-8 (two concurrent attempts on one task) is a reachability property, not
  // an invariant; test.qnt checks it with WIT_ACT8_two_attempts.

  // ENV-1 / input domain checks: every txn in the model keeps its fixed payload;
  // operations are in the accepted set and amounts are positive.
  val ENV_1_payload: bool =
    world.buckets.keys().forall(k =>
      world.buckets.get(k).txns.foldl(true, (acc, t) =>
        acc and t.account == TXN_ACCOUNT.get(t.txid)
        and t.op == TXN_OP.get(t.txid)
        and t.amount == TXN_AMOUNT.get(t.txid)))
    and world.tasks.keys().forall(tid =>
      world.tasks.get(tid).txns.foldl(true, (acc, t) =>
        acc and t.account == TXN_ACCOUNT.get(t.txid)
        and t.op == TXN_OP.get(t.txid)
        and t.amount == TXN_AMOUNT.get(t.txid)))
    and world.applied.foldl(true, (acc, row) =>
      acc and row.op == TXN_OP.get(row.txid) and row.amount == TXN_AMOUNT.get(row.txid))

  val ENV_2_amount_domain: bool =
    TXN_IDS.forall(txid => opValid(TXN_OP.get(txid)) and TXN_AMOUNT.get(txid) > 0)

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  action init: bool = all { world' = initWorld }

  action Ingest(txid: TxnId): bool = all { world' = ingestTxn(world, txid) }

  action Tick(delta: int): bool = all {
    delta > 0,
    world.now + delta > world.now,
    world' = { ...world, now: world.now + delta },
  }

  // CLOSE_ONE_LUA has no TIME re-check: the timer may fire at any point from the
  // window start onward, including before windowStart+250 (RULES.md ACT-7 / Q1).
  action TimerClose: bool = all {
    world.buckets.keys().size() > 0,
    {
      nondet k = world.buckets.keys().oneOf()
      all {
        world.now >= k.windowStart,
        world.buckets.get(k).txns.length() > 0,
        world' = closeBucket(world, k, "timer"),
      }
    },
  }

  // SWEEP_LUA closes only windows whose score (windowStart+250) is <= Redis TIME.
  action Sweep: bool = {
    val due =
      world.buckets.keys().filter(k => world.now >= k.windowStart + WINDOW_MS)
    all {
      due.size() > 0,
      {
        nondet k = due.oneOf()
        all {
          world.buckets.get(k).txns.length() > 0,
          world' = closeBucket(world, k, "sweep"),
        }
      },
    }
  }

  // BLMOVE tasks:global -> processing:{worker}.
  action Acquire(worker: WorkerId): bool = all {
    world.attempts.get(worker).phase == Idle,
    world.queued.size() > 0,
    {
      nondet tid = world.queued.oneOf()
      all {
        world' = {
          ...world,
          queued: world.queued.exclude(Set(tid)),
          attempts: world.attempts.put(worker, {
            ...IDLE_ATTEMPT,
            taskId: tid,
            phase: Reading,
          }),
        }
      }
    },
  }

  action Read(worker: WorkerId): bool = {
    val ok = world.attempts.get(worker).phase == Reading
    all {
      ok,
      world' = if (ok) readAttempt(world, worker) else world,
    }
  }

  action Commit(worker: WorkerId): bool = {
    val a = world.attempts.get(worker)
    val hasTask = world.tasks.keys().contains(a.taskId)
    val ok =
      if (hasTask) {
        val task = world.tasks.get(a.taskId)
        a.phase == Ready
        and a.applied.length() > 0
        and world.accounts.get(task.key.account).version == a.snapshotVersion
      } else false
    all {
      ok,
      world' = if (ok) commitAttempt(world, worker, world.tasks.get(a.taskId), a) else world,
    }
  }

  action Noop(worker: WorkerId): bool = {
    val a = world.attempts.get(worker)
    val hasTask = world.tasks.keys().contains(a.taskId)
    val ok = hasTask and a.phase == Ready and a.applied.length() == 0
    all {
      ok,
      world' = if (ok) noopAttempt(world, worker, world.tasks.get(a.taskId), a) else world,
    }
  }

  action Conflict(worker: WorkerId): bool = {
    val a = world.attempts.get(worker)
    val hasTask = world.tasks.keys().contains(a.taskId)
    val ok =
      if (hasTask) {
        val task = world.tasks.get(a.taskId)
        a.phase == Ready
        and a.applied.length() > 0
        and world.accounts.get(task.key.account).version != a.snapshotVersion
        and a.retries < MAX_OCC_RETRIES - 1
      } else false
    all {
      ok,
      world' = if (ok) conflictAttempt(world, worker, world.tasks.get(a.taskId), a) else world,
    }
  }

  action GiveUp(worker: WorkerId): bool = {
    val a = world.attempts.get(worker)
    val hasTask = world.tasks.keys().contains(a.taskId)
    val ok =
      if (hasTask) {
        val task = world.tasks.get(a.taskId)
        a.phase == Ready
        and a.applied.length() > 0
        and world.accounts.get(task.key.account).version != a.snapshotVersion
        and a.retries >= MAX_OCC_RETRIES - 1
      } else false
    all {
      ok,
      world' = if (ok) giveUpAttempt(world, worker) else world,
    }
  }

  // Reclaim while the stale attempt is still live is what makes two concurrent
  // attempts on one task reachable (ENV-3 / Q13).
  action Reclaim(worker: WorkerId): bool = {
    val a = world.attempts.get(worker)
    val ok = a.phase != Idle and world.tasks.keys().contains(a.taskId)
    all {
      ok,
      world' = if (ok) reclaimAttempt(world, worker) else world,
    }
  }

  action step: bool = {
    nondet txid = TXN_IDS.oneOf()
    nondet worker = WORKERS.oneOf()
    nondet delta = TIME_DELTAS.oneOf()
    any {
      Ingest(txid),
      Tick(delta),
      TimerClose,
      Sweep,
      Acquire(worker),
      Read(worker),
      Commit(worker),
      Noop(worker),
      Conflict(worker),
      GiveUp(worker),
      Reclaim(worker),
    }
  }
}
