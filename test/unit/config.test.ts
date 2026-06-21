import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config';

describe('loadConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('在沒有環境變數時回傳預設值', () => {
    delete process.env.SERVICE_NAME;
    delete process.env.PORT;
    delete process.env.AZ_ID;
    const cfg = loadConfig();
    expect(cfg.serviceName).toBe('unknown');
    expect(cfg.port).toBe(3000);
    expect(cfg.azId).toBe('az-local');
  });

  it('讀取環境變數覆寫', () => {
    process.env.SERVICE_NAME = 'batch-process';
    process.env.PORT = '3001';
    process.env.AZ_ID = 'az-2';
    const cfg = loadConfig();
    expect(cfg.serviceName).toBe('batch-process');
    expect(cfg.port).toBe(3001);
    expect(cfg.azId).toBe('az-2');
  });
});
