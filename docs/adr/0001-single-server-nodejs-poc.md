# 0001. 以單機 Node.js + Docker 多程序實作 PoC，而非 spec 描述的分散式 Multi-AZ 架構

- 狀態：已採納
- 日期：2026-06-21

## 背景

`docs/Payment Batching PoC Specs.md` 描述的是一個**生產級分散式架構**：三微服務解耦、Redis 叢集、Multi-AZ 冗餘部署、User Account Store + Transaction DB 雙資料庫、Apache Kafka 下游管道，並隱含 JVM 風格的線程池/線程鎖調校語彙。

但本次任務的明確目標經 grilling 釐清為：

1. **PoC 命題 = 架構可行性 demo** —— 產出一個能跑、能展示端到端資料流的可運行原型，**不追求嚴格 benchmark，也不追求形式化正確性證明**。
2. 技術棧候選為 **Node.js 或 Spring Boot + Redis 的「單一伺服器」**。

「可行性 demo」與「單一伺服器」這兩個約束，與 spec 的分散式生產架構天生衝突。必須決定如何取捨。

## 決策

採用 **Node.js (TypeScript) + Redis + Postgres，以 Docker Compose 在單一伺服器上跑多個程序**。

具體取捨：

- **語言/執行環境**：Node.js (TypeScript)，而非 Spring Boot。
- **拓撲**：單一伺服器、多 OS 程序（容器）。1 個 batch-creator、3 個 batch-process（各帶 AZ 識別碼）、1 個 post-process、redis、postgres、load-generator。
- **服務間通訊**：前端 → Creator 用 **HTTP REST**；後端服務之間**全部經由 Redis（任務佇列、results cache）與 Postgres 協調，不引入 gRPC**。
- **主資料庫**：Postgres，承載真實的樂觀鎖條件寫入 `UPDATE ... WHERE version = ?`。
- **必展示機制**：250ms 窗口聚合（Lua + Redis TIME 權威時鐘）、狀態機可視化、多 worker 競爭 + Exactly-Once、MicroUAC 48-byte 二進位、批次 vs 天真單筆對照。
- **省略/stub 的機制**：Redis 崩潰降級、Tentative/Committed 完整審計、影子雙寫校驗、10–15x 流量放大壓測。

## 理由

- 系統真正的新意（250ms 窗口聚合、Redis TIME 權威時鐘、全域任務佇列）**集中在 Redis + Lua 層，與服務層語言無關**；兩個候選棧在這一層完全相同。差異只在服務層語言，因此選較輕、建 demo 較快的 Node.js。
- Spring Boot 的優勢（thread pool、線程鎖調校）只有在「效能命題」才真正發揮，而 PoC 命題已定為可行性 demo，非效能。
- 多 OS 程序（容器）能忠實重現 spec 的「多節點競爭領取同一佇列」，log 直接看得見誰搶到、誰因樂觀鎖失敗重試 —— 比單程序 async/worker_threads 更有 demo 說服力，且仍滿足「單一伺服器」約束。
- 後端不引 gRPC：在已收斂的設計中，唯一的同步服務對服務呼叫（Process → Post-Process）本就被降級，引入 proto 工具鏈幾乎無用武之地。

## 影響

- **正面**：建置與展示成本最低；核心機制（Lua）零妥協；可視化與 load 腳本容易（REST/瀏覽器直連）；忠實展現多節點競爭。
- **負面 / 本 PoC 明確不驗證的事**：
  - 無法驗證真正的 Multi-AZ 跨區容錯（同機多容器只是模擬）。
  - 無法驗證分散式時鐘漂移問題（單機共用一個 Redis 即權威時鐘，問題天然消失，但也就沒被「證明解決」）。
  - 不產出可信的吞吐/延遲 benchmark 數字（壓縮比為示意，非嚴格量測）。
  - Spring Boot 路線的線程池/線程鎖行為不在本 PoC 觀察範圍。
- 若日後要把此 PoC 推向生產級驗證，需另起爐灶處理上述未驗證項（真實多區部署、分散式時鐘、嚴格壓測）。
