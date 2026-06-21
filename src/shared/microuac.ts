// MicroUAC：48-byte 緊湊審計記錄的二進位編解碼（big-endian）。
// 欄位佈局（offset / size）：
//   0  TransactionID   Int64   (8)
//   8  OperationType   UInt8   (1)
//   9  Amount          Int64   (8)
//   17 SequenceNumber  UInt16  (2)
//   19 AccountVersion  UInt32  (4)
//   23 ReferenceHash   Binary  (16)
//   39 BusinessTime    UInt32  (4)
//   43 ReservedBytes   Binary  (5)
//   ────────────────────────── 共 48 bytes

export const MICRO_UAC_SIZE = 48;
const REFERENCE_HASH_SIZE = 16;
const RESERVED_SIZE = 5;

export interface MicroUAC {
  transactionId: bigint; // Int64
  operationType: number; // UInt8
  amount: bigint; // Int64（最小貨幣單位）
  sequenceNumber: number; // UInt16，批次內順序
  accountVersion: number; // UInt32，此變更提交後的賬戶版本
  referenceHash: Buffer; // 16 bytes（業務單據 MD5）
  businessTime: number; // UInt32，Unix 秒
  reserved?: Buffer; // 5 bytes，預設全 0
}

export function packMicroUAC(u: MicroUAC): Buffer {
  if (u.referenceHash.length !== REFERENCE_HASH_SIZE) {
    throw new Error(`referenceHash must be ${REFERENCE_HASH_SIZE} bytes`);
  }
  const buf = Buffer.alloc(MICRO_UAC_SIZE);
  buf.writeBigInt64BE(u.transactionId, 0);
  buf.writeUInt8(u.operationType, 8);
  buf.writeBigInt64BE(u.amount, 9);
  buf.writeUInt16BE(u.sequenceNumber, 17);
  buf.writeUInt32BE(u.accountVersion, 19);
  u.referenceHash.copy(buf, 23, 0, REFERENCE_HASH_SIZE);
  buf.writeUInt32BE(u.businessTime, 39);
  if (u.reserved) u.reserved.copy(buf, 43, 0, RESERVED_SIZE);
  return buf;
}

export function unpackMicroUAC(buf: Buffer): MicroUAC {
  if (buf.length !== MICRO_UAC_SIZE) {
    throw new Error(`MicroUAC buffer must be ${MICRO_UAC_SIZE} bytes, got ${buf.length}`);
  }
  return {
    transactionId: buf.readBigInt64BE(0),
    operationType: buf.readUInt8(8),
    amount: buf.readBigInt64BE(9),
    sequenceNumber: buf.readUInt16BE(17),
    accountVersion: buf.readUInt32BE(19),
    referenceHash: Buffer.from(buf.subarray(23, 39)),
    businessTime: buf.readUInt32BE(39),
    reserved: Buffer.from(buf.subarray(43, 48)),
  };
}
