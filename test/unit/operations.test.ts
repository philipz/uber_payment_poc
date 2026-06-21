import { describe, expect, it } from 'vitest';
import { applyOperation } from '../../src/shared/operations';
import { OperationType } from '../../src/shared/types';

describe('applyOperation', () => {
  it('Credit 增加餘額', () => {
    expect(applyOperation(100, OperationType.Credit, 50)).toBe(150);
  });

  it('Debit 減少餘額', () => {
    expect(applyOperation(100, OperationType.Debit, 30)).toBe(70);
  });

  it('Authorize 視為保留扣減', () => {
    expect(applyOperation(100, OperationType.Authorize, 40)).toBe(60);
  });

  it('Release 視為回補', () => {
    expect(applyOperation(100, OperationType.Release, 40)).toBe(140);
  });

  it('未知操作丟出例外', () => {
    expect(() => applyOperation(100, 0x99 as OperationType, 1)).toThrow();
  });
});
