import http from 'node:http';

// 啟動一個最小的健康檢查 HTTP 伺服器。
// 回傳建立的 server 以便後續切片掛載更多路由。
export function startHealthServer(
  port: number,
  serviceName: string,
  routes?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: serviceName }));
      return;
    }
    // 讓呼叫端先處理自訂路由；若已處理則結束
    if (routes && routes(req, res)) {
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (err) => {
    console.error(`[${serviceName}] health server error:`, err);
  });

  server.listen(port, () => {
    console.log(`[${serviceName}] health server listening on :${port}`);
  });

  return server;
}
