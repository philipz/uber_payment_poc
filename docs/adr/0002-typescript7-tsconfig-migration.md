# 0002. TypeScript 7 升版：tsconfig 遷移至 `module: nodenext`

- 狀態：已採納
- 日期：2026-08-22

## 背景

依賴升版 PR（`dependabot/npm_and_yarn/typescript-7.0.2`，原 PR #28）把 `typescript`
由 `5.9.3` 升到 `7.0.2` 後，CI 的 `Lint / Build / Unit` 與 E2E 建置雙雙失敗：

```
tsconfig.json(5,25): error TS5108: Option 'moduleResolution=node10' has been removed.
Please remove it from your configuration.
```

根因：TypeScript 7 移除了 `moduleResolution: "node"`（即舊稱 `node10`）選項。既有
`tsconfig.json` 使用 `"moduleResolution": "node"`，在 TS7 下即報 `TS5108`。

## 決策

把 `tsconfig.json` 遷移至 TS7 仍支援的 `nodenext` 家族：

- `"module": "commonjs"` → `"module": "nodenext"`
- `"moduleResolution": "node"` → `"moduleResolution": "nodenext"`

## 理由

- TS7 對 `moduleResolution`/`module` 組合有嚴格限制（`TS5110`）：`node16`/`nodenext`
  resolution 必須搭配 `module: node16`/`nodenext`；選 `bundler` 又需 ESM module。
- 本專案 package.json 未宣告 `"type": "module"`，`module: nodenext` 仍以 CommonJS
  產出（`dist/**/*.js` 維持 `require(...)` 語義），執行期行為不變，Minimal 且低風險。
- 保留 `esModuleInterop`，`require`/`import` 互動維持既有行為。

## 影響

- 測試層先在 `it.skip`（斷言完整保留）定義「tsconfig 不再使用已移除的 `node`/`node10`」
  契約，實作層 un-skip 並套用本決策後轉綠。
- `npm run build`、`npm run typecheck`、單元測試在 TS5 基線與 TS7 目標版皆綠燈。
- 未更動 `module` 產物語義（仍為 CommonJS），無執行期行為變更。
