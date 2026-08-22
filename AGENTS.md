# Repository Guidelines

## Project Structure
- Core code lives in `src/services/`，每個服務一個目錄（`batch-creator` / `batch-process` / `post-process` / `load-generator`），入口皆為 `index.ts`；跨服務共用邏輯放 `src/shared/`（`operations`、`lua`、`microuac`、`keys`、`events`、`types`、`config`、`redis`、`health`）。
- 領域詞彙表見 `CONTEXT.md`（Hot Account、Batch、Exactly-Once、OCC…）；架構決策記錄於 `docs/adr/`，新增決策先寫 ADR 再動程式。
- Schema 定義於 `db/init.sql`；本機基礎設施（Redis / Postgres / 各服務）由 `docker-compose.yml` 管理。

## Build, Test & Development Commands
- `npm ci` 安裝依賴（lockfile 鎖定）；`npm run build`（tsc）編譯到 `dist/`。
- `npm run lint` 執行 Prettier 檢查；`npm run format` 自動排版。
- `npm run test:unit` 跑單元測試（vitest，`test/unit/`，不需外部服務）；`npm run test:e2e` 跑 E2E（`test/e2e/`，需先 `docker compose up -d --build` 拉起 stack）。
- `npm run start:creator` / `start:process` / `start:post` 分別啟動各服務。

## Coding Style & Naming Conventions
- TypeScript strict 模式（`tsconfig.json`）；排版由 Prettier（`.prettierrc.json`）規範，避免手動調整格式。
- 服務目錄命名 kebab-case；共用模組檔案以職責命名（`operations.ts`、`microuac.ts`）；環境設定統一經 `src/shared/config.ts` 讀取，不散落 `process.env`。

## Testing Guidelines
- 預設使用 Vitest；單元測試放 `test/unit/`，E2E 放 `test/e2e/`（共用 compose stack、`fileParallelism: false` 序列執行）。
- 單元測試不得依賴外部服務（Redis/Postgres）——純邏輯（`microuac`、`operations`、`config`）直接測；涉及 Redis/Lua 的行為用 E2E 驗證。
- 測試方法名應讀起來像行為陳述；保留既有斷言，不得為讓測試通過而刪除或弱化斷言。

## Commit & Pull Request Guidelines
- 採用 Conventional Commits（`feat:` / `fix:` / `test:` / `docs:` / `chore:`）。
- Commit 保持單一內聚變更；PR 描述須說明做什麼、為什麼、驗證命令（`npm run test:unit` 等）。
- 工廠（software factory）工作項：依 `.dsh/skills/factory-pr-stacking` 拆分 stacked PR，base 為 `software-factory` 分支（**絕不 push 到 main**）；依 `.dsh/skills/factory-stop-rules` 停手，完成後寫 `.factory/run/report.json`（見 `.dsh/skills/factory-workflow`）。

## Configuration & Operations Tips
- 執行期行為以環境變數覆寫（`PORT`、`SERVICE_NAME`、`AZ_ID`、`REDIS_URL`、`DATABASE_URL`，見 `src/shared/config.ts`）；`.env` 已 gitignore。
- 本機驗證：`docker compose up -d --build` 後等容器健康（`docker compose ps` 檢查 health），再跑 `npm run test:e2e`；`docker compose down -v` 收尾。
- PoC 的高並發/計時行為（250ms time window）受測試逾時影響——改動前先看 `vitest.config.ts` 的逾時設定。
