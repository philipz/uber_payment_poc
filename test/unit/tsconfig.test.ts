import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * TypeScript 7 移除了 `moduleResolution: node`（即舊稱 node10）選項
 * （`error TS5108: Option 'moduleResolution=node10' has been removed`）。
 * 本測試守住建置設定與 TS7 相容，避免 restate PR #28 的升版錯誤。
 */
describe('tsconfig 與 TypeScript 7 相容', () => {
  const tsconfigPath = path.resolve(__dirname, '../../tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
    compilerOptions: { moduleResolution?: string; module?: string };
  };

  it('moduleResolution 為 TS7 仍支援的值（非已移除的 node/node10）', () => {
    const { moduleResolution } = tsconfig.compilerOptions;
    expect(moduleResolution).toBeDefined();
    // TS7 已移除 node10；moduleResolution === 'node' 是 node10 的舊別名
    expect(moduleResolution?.toLowerCase()).not.toBe('node');
    expect(moduleResolution?.toLowerCase()).not.toBe('node10');
  });

  it('module 需與 moduleResolution 匹配（nodenext/node16 系列）', () => {
    const { module, moduleResolution } = tsconfig.compilerOptions;
    expect(moduleResolution).toBeDefined();
    if (moduleResolution === 'nodenext') {
      expect(module).toBe('nodenext');
    } else if (moduleResolution === 'node16') {
      expect(module).toBe('node16');
    }
  });
});
