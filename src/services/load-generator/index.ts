import { loadConfig } from '../../shared/config';
import { runComparison, type ScenarioResult } from './runner';

// 對單一熱點賬戶灌可設定負載，並排對照 batched vs naive 的壓縮比與攤薄延遲。
// 設定（環境變數）：
//   LOAD_BASE_URL（預設 http://batch-creator:3000）
//   LOAD_ACCOUNT（預設 hot-account-1）
//   LOAD_CONCURRENCY（預設 20）
//   LOAD_DURATION_MS（預設 3000）
const config = loadConfig();
const baseUrl = process.env.LOAD_BASE_URL ?? 'http://batch-creator:3000';
const account = process.env.LOAD_ACCOUNT ?? 'hot-account-1';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 20);
const durationMs = Number(process.env.LOAD_DURATION_MS ?? 3000);

function fmtRow(label: string, b: string, n: string): string {
  return `  ${label.padEnd(20)} ${b.padStart(14)} ${n.padStart(14)}`;
}

function render(r: ScenarioResult): {
  req: string;
  db: string;
  ratio: string;
  tput: string;
  lat: string;
} {
  return {
    req: String(r.requests),
    db: String(r.dbWrites),
    ratio: r.ratio.toFixed(1) + 'x',
    tput: r.throughput.toFixed(1) + '/s',
    lat: r.avgLatencyMs.toFixed(0) + 'ms',
  };
}

async function main(): Promise<void> {
  console.log(
    `[${config.serviceName}] 開始對照負載：account=${account} concurrency=${concurrency} duration=${durationMs}ms`,
  );
  const { batched, naive } = await runComparison({ baseUrl, account, concurrency, durationMs });
  const b = render(batched);
  const n = render(naive);

  console.log('\n  ===== 批次 vs 天真單筆 對照 =====');
  console.log(fmtRow('', 'batched', 'naive'));
  console.log(fmtRow('請求數(成功)', b.req, n.req));
  console.log(fmtRow('DB 寫入數', b.db, n.db));
  console.log(fmtRow('壓縮比(請求/寫入)', b.ratio, n.ratio));
  console.log(fmtRow('吞吐量', b.tput, n.tput));
  console.log(fmtRow('平均延遲', b.lat, n.lat));
  console.log(
    `\n  → 批次模式以 ${b.ratio} 壓縮比把 ${batched.requests} 筆請求攤平到 ${batched.dbWrites} 次 DB 寫入；` +
      `天真模式為 ${n.ratio}（幾乎 1:1）。`,
  );
}

void main().then(() => process.exit(0));
