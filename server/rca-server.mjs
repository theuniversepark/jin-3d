// RCA 전담 서버 (더미) 단독 실행 — 앱 없이 REST API만 띄운다 (외부 MES·테스트 클라이언트 연동 확인용)
//   node server/rca-server.mjs [--port 8775] [--host 127.0.0.1]   ·   npm run rca-server
// 앱(맥 앱 · npm start)에서는 같은 API가 앱 서버의 /api/rca/v1/로 함께 열린다.
import http from 'node:http';
import { makeRcaApi } from './rca-api.mjs';
import { guard, isLoopbackHost } from './http-guard.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', process.env.RCA_PORT || 8775)), host = arg('host', process.env.RCA_HOST || '127.0.0.1');
const { route } = makeRcaApi();
http.createServer((req, res) => {
  if (guard(req, res, { loopback: isLoopbackHost(host) })) return;   // 다른 웹페이지가 보낸 요청 거부
  const url = new URL(req.url, 'http://localhost'); let body = '';
  req.on('data', (c) => { body += c; if (body.length > 16 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    const r = url.pathname.startsWith('/api/rca/v1') ? route(req.method, url.pathname, url.searchParams, body) : null;
    const out = r ?? { code: 404, body: { error: 'Not found — /api/rca/v1/…' } };
    res.writeHead(out.code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out.body));
  });
}).listen(port, host, () => console.log(`RCA 서버 (더미) http://${host}:${port}/api/rca/v1/status`));
