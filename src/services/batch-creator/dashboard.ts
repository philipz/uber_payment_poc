// 單頁儀表板：以 EventSource 訂閱 /events，即時顯示狀態機流轉、餘額/版本、AZ 競爭。
export const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Payment Batching PoC — 即時儀表板</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background: #0d1117; color: #c9d1d9; }
  header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  header .meta { color: #8b949e; font-size: 12px; }
  .wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
  @media (max-width: 800px) { .wrap { grid-template-columns: 1fr; } }
  h2 { font-size: 13px; color: #8b949e; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .5px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; white-space: nowrap; }
  th { color: #8b949e; font-weight: 600; }
  .log { max-height: 70vh; overflow: auto; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .Ingested { background: #1f6feb33; color: #79c0ff; }
  .Accumulating { background: #9e6a0333; color: #e3b341; }
  .Queued { background: #8957e533; color: #d2a8ff; }
  .Processing { background: #1f6feb33; color: #79c0ff; }
  .Committed { background: #23863633; color: #56d364; }
  .Finalized { background: #2386361a; color: #3fb950; }
  .az { color: #f0883e; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<header>
  <h1>Payment Batching PoC</h1>
  <span class="meta">狀態機即時流轉 · <span id="status">連線中…</span> · 事件數 <span id="count">0</span></span>
</header>
<div class="wrap">
  <div>
    <h2>賬戶最新狀態</h2>
    <table>
      <thead><tr><th>Account</th><th>狀態</th><th class="num">餘額</th><th class="num">版本</th><th>AZ</th></tr></thead>
      <tbody id="accounts"></tbody>
    </table>
  </div>
  <div>
    <h2>事件流（最新在上）</h2>
    <div class="log">
      <table>
        <thead><tr><th>時間</th><th>狀態</th><th>Account</th><th class="num">版本</th><th class="num">餘額</th><th>AZ</th><th>size</th></tr></thead>
        <tbody id="events"></tbody>
      </table>
    </div>
  </div>
</div>
<script>
  const accounts = {};
  const accountsEl = document.getElementById('accounts');
  const eventsEl = document.getElementById('events');
  const countEl = document.getElementById('count');
  const statusEl = document.getElementById('status');
  let count = 0;
  const fmt = (v) => (v === undefined || v === null ? '' : v);
  const time = (ts) => new Date(ts).toLocaleTimeString('zh-Hant', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0');
  // 縱深防禦：所有動態值插入 DOM 前先做 HTML 轉義
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function renderAccounts() {
    accountsEl.innerHTML = Object.values(accounts)
      .sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map((a) =>
        '<tr><td>' + esc(a.accountId) + '</td><td><span class="pill ' + esc(a.state) + '">' + esc(a.state) + '</span></td>' +
        '<td class="num">' + esc(fmt(a.balance)) + '</td><td class="num">' + esc(fmt(a.version)) + '</td>' +
        '<td class="az">' + esc(fmt(a.az)) + '</td></tr>'
      ).join('');
  }

  function onEvent(e) {
    count++; countEl.textContent = count;
    const a = accounts[e.accountId] || (accounts[e.accountId] = { accountId: e.accountId });
    a.state = e.state;
    if (e.balance !== undefined) a.balance = e.balance;
    if (e.version !== undefined) a.version = e.version;
    if (e.az) a.az = e.az;
    renderAccounts();

    const row = document.createElement('tr');
    row.innerHTML =
      '<td>' + esc(time(e.ts)) + '</td><td><span class="pill ' + esc(e.state) + '">' + esc(e.state) + '</span></td>' +
      '<td>' + esc(e.accountId) + '</td><td class="num">' + esc(fmt(e.version)) + '</td>' +
      '<td class="num">' + esc(fmt(e.balance)) + '</td><td class="az">' + esc(fmt(e.az)) + '</td>' +
      '<td class="num">' + esc(fmt(e.size)) + '</td>';
    eventsEl.prepend(row);
    while (eventsEl.children.length > 200) eventsEl.removeChild(eventsEl.lastChild);
  }

  const es = new EventSource('/events');
  es.onopen = () => { statusEl.textContent = '已連線'; };
  es.onerror = () => { statusEl.textContent = '連線中斷，重試中…'; };
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch (_) {} };
</script>
</body>
</html>
`;
