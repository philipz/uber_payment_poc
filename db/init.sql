-- User Account Store（主資料庫）schema 與種子資料
-- 金額一律以最小貨幣單位（分）儲存為 BIGINT，消除浮點數精度偏差。

CREATE TABLE IF NOT EXISTS accounts (
  id      TEXT    PRIMARY KEY,
  balance BIGINT  NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

-- 審計表：MicroUAC 以 48-byte 二進位（BYTEA）儲存（Phase 4 填入）
CREATE TABLE IF NOT EXISTS audit (
  id         BIGSERIAL   PRIMARY KEY,
  account_id TEXT        NOT NULL,
  micro_uac  BYTEA       NOT NULL,
  status     TEXT        NOT NULL CHECK (status IN ('Tentative', 'Committed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_account ON audit (account_id);

-- 種子熱點賬戶
INSERT INTO accounts (id, balance, version)
VALUES ('hot-account-1', 0, 0)
ON CONFLICT (id) DO NOTHING;
