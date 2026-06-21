# Uber Payment Batching POC

高並發金融賬本「250ms 時間窗口批次處理」可行性 demo。
設計見 [`docs/Implementation Plan.md`](docs/Implementation%20Plan.md)、決策見 [`docs/adr/`](docs/adr/)、領域詞彙見 [`CONTEXT.md`](CONTEXT.md)。

技術棧：Node.js (TypeScript) + Redis + Postgres，Docker Compose 多容器（單一伺服器）。

## 參考資料

* https://www.infoq.cn/article/pXMkt6weMsrbNNvZR0pM
* https://www.infoq.com/news/2026/06/uber-payment-batching-system/
* https://www.uber.com/us/en/blog/high-throughput-processing/

## 快速開始

```bash
docker compose up -d --build      # 啟動 redis / postgres / 三個服務
docker compose ps                 # 應看到全部 healthy
curl http://localhost:3000/health # batch-creator → {"status":"ok",...}
docker compose down               # 關閉
```

## 服務

| 服務 | 角色 | Port |
| ---- | ---- | ---- |
| batch-creator | 接收 REST、Redis 窗口歸集、輪詢結果回應 | 3000（對外）|
| batch-process | 競爭領取任務、樂觀鎖寫入主庫（Phase 3 擴成 3 個 AZ）| 3001 |
| post-process | 非同步審計（MicroUAC）、下游 stub | 3002 |
| redis | 窗口協調 / 全域佇列 / results cache | 6379 |
| postgres | User Account Store + 審計表 | 5432 |
| load-generator | 負載/對照工具（profile `tools`，預設不啟動）| — |

## 本機開發

```bash
npm install
npm run build      # tsc → dist/
npm run lint       # prettier 檢查
npm run format     # prettier 修正
```

## 實作進度

依 issue #1–#7（Phase 0–6）沿依賴鏈推進。目前完成 **Phase 0：專案骨架與 Compose 骨幹**。

