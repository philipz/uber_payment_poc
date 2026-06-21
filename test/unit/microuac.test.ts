import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  MICRO_UAC_SIZE,
  packMicroUAC,
  unpackMicroUAC,
  type MicroUAC,
} from '../../src/shared/microuac';
import { OperationType } from '../../src/shared/types';

describe('MicroUAC pack/unpack', () => {
  const sample: MicroUAC = {
    transactionId: 1234567890123n,
    operationType: OperationType.Debit,
    amount: 99999n,
    sequenceNumber: 7,
    accountVersion: 42,
    referenceHash: createHash('md5').update('order-abc').digest(),
    businessTime: 1782000000,
  };

  it('打包長度恰為 48 bytes', () => {
    expect(packMicroUAC(sample).length).toBe(MICRO_UAC_SIZE);
  });

  it('round-trip 後各欄位一致', () => {
    const decoded = unpackMicroUAC(packMicroUAC(sample));
    expect(decoded.transactionId).toBe(sample.transactionId);
    expect(decoded.operationType).toBe(sample.operationType);
    expect(decoded.amount).toBe(sample.amount);
    expect(decoded.sequenceNumber).toBe(sample.sequenceNumber);
    expect(decoded.accountVersion).toBe(sample.accountVersion);
    expect(decoded.referenceHash.equals(sample.referenceHash)).toBe(true);
    expect(decoded.businessTime).toBe(sample.businessTime);
    expect(decoded.reserved?.length).toBe(5);
  });

  it('referenceHash 非 16 bytes 應丟錯', () => {
    expect(() => packMicroUAC({ ...sample, referenceHash: Buffer.alloc(8) })).toThrow();
  });

  it('錯誤長度的 buffer 解碼應丟錯', () => {
    expect(() => unpackMicroUAC(Buffer.alloc(40))).toThrow();
  });
});
