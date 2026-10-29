// Concrete configuration and instances for specs/quint/model.qnt.
//
// `config` holds the single source of truth for every constant value. Both the
// verification instance (`main`) and the witness module (test.qnt) bind the
// model from it, so the two cannot drift apart. Rationale for every value is
// recorded in REPORT.md ("Instances and constants").
module config {
  // ACCOUNTS / INITIAL_BALANCE: db/init.sql:33-35 seeds hot-account-1 with
  // balance 0; db/init.sql:6 defaults balance to 0. The program accepts any
  // accountId matching ^[A-Za-z0-9_-]+$ (src/services/batch-creator/index.ts:68,
  // 182-186) and returns 404 for rows that do not exist
  // (src/services/batch-process/index.ts:120-123,207-209). Sampling the one
  // seeded account is a state-space choice, not a program restriction.
  pure val CFG_ACCOUNTS: Set[str] = Set("hot-account-1")
  pure val CFG_INITIAL_BALANCE: str -> int = Map("hot-account-1" -> 0)

  // transactionId only has to be a non-empty string
  // (src/services/batch-creator/index.ts:132); no other program bound.
  pure val CFG_TXN_IDS: Set[str] = Set("tx-1", "tx-2", "tx-3", "tx-4", "tx-5")

  // ENV-1 (RULES.md): each txid has a fixed (account, op, amount) payload. The
  // program does NOT re-validate the payload on retry
  // (src/services/batch-process/index.ts:128-143); this is an upstream premise,
  // exactly as RULES.md states, not an assumption invented by the model.
  pure val CFG_TXN_ACCOUNT: str -> str = Map(
    "tx-1" -> "hot-account-1",
    "tx-2" -> "hot-account-1",
    "tx-3" -> "hot-account-1",
    "tx-4" -> "hot-account-1",
    "tx-5" -> "hot-account-1",
  )

  // 1 Credit, 2 Debit, 3 Authorize, 4 Release (src/shared/types.ts:4-9).
  // All four operation codes are covered.
  pure val CFG_TXN_OP: str -> int = Map(
    "tx-1" -> 1,
    "tx-2" -> 2,
    "tx-3" -> 3,
    "tx-4" -> 4,
    "tx-5" -> 1,
  )

  // amount is only required to be a positive integer with no program upper bound
  // (src/services/batch-creator/index.ts:134). Values cover:
  //   1  the minimum,
  //   2  an even value,
  //   3/4 the remaining operation types,
  //   9007199254740991 = 2^53-1, the largest integer exactly representable as a
  //   JS number (amount enters as a JS number before the BIGINT column).
  // This is a sampling domain, not a program restriction; no assume narrows it.
  pure val CFG_TXN_AMOUNT: str -> int = Map(
    "tx-1" -> 1,
    "tx-2" -> 2,
    "tx-3" -> 3,
    "tx-4" -> 4,
    "tx-5" -> 9007199254740991,
  )
}

// The verification instance. Run with --main=main.
module main {
  import config.* from "./instances"
  import model(
    ACCOUNTS = CFG_ACCOUNTS,
    INITIAL_BALANCE = CFG_INITIAL_BALANCE,
    TXN_IDS = CFG_TXN_IDS,
    TXN_ACCOUNT = CFG_TXN_ACCOUNT,
    TXN_OP = CFG_TXN_OP,
    TXN_AMOUNT = CFG_TXN_AMOUNT,
  ).* from "./model"
}
