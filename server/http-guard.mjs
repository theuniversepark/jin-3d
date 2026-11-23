// 로컬 서버 요청 출처 검사 — 앱 서버(server/app-server.mjs)가 쓴다. 따로 띄우는 서버가 생기면 같은 guard()를 맨 앞에 붙인다.
// 127.0.0.1에만 열어도 사용자가 띄운 다른 웹페이지(브라우저)는 이 주소로 요청을 보낼 수 있다.
// 그래서 브라우저가 붙이는 출처 정보로 "이 앱 화면이 보낸 요청"만 받는다. 브라우저가 아닌 클라이언트(curl · MES · 테스트)는 출처 헤더를 보내지 않으므로 그대로 받는다.
//  ① Host — 루프백에 연 서버는 Host가 127.0.0.1 · localhost · [::1]일 때만 (DNS 리바인딩: 남의 도메인이 127.0.0.1로 풀려 들어오는 요청을 막는다)
//  ② Origin — 있으면 요청 받은 주소(Host)와 같은 출처여야 한다 ('null' 출처 포함 거부)
//  ③ Sec-Fetch-Site — cross-site · same-site면 거부 (같은 PC의 다른 포트 페이지, <img>·<form> 같은 출처 헤더 없는 요청도 여기서 걸린다)
import net from 'node:net';
const LOOPBACK = new Set(['localhost', '::1', '[::1]']);
// 127.0.0.0/8은 실제 IPv4 주소일 때만 — '127.attacker.example' 같은 도메인은 루프백이 아니다 (DNS 리바인딩으로 127.0.0.1에 풀릴 수 있음)
export const isLoopbackHost = (h) => { const s = String(h ?? '').toLowerCase(); return LOOPBACK.has(s) || (net.isIPv4(s) && s.startsWith('127.')); };
const hostname = (hostHeader) => { try { return new URL(`http://${hostHeader}`).hostname; } catch { return null; } };

// 거부 사유(문자열) 또는 null(통과)
export function rejectReason(req, { loopback = true } = {}) {
  const H = req.headers, host = H.host;
  if (!host) return 'Host 헤더가 없습니다';
  if (loopback && !isLoopbackHost(hostname(host))) return `허용하지 않는 Host — ${host}`;
  const site = H['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return `다른 사이트에서 온 요청 (${site})`;
  const origin = H.origin;
  if (origin != null) {
    let o = null; try { o = new URL(origin); } catch { /* 'null' 등 */ }
    if (!o || !/^https?:$/.test(o.protocol) || o.host !== String(host).toLowerCase()) return `다른 출처에서 온 요청 — ${origin}`;
  }
  return null;
}

// 거부했으면 403을 보내고 true
export function guard(req, res, opts) {
  const why = rejectReason(req, opts);
  if (!why) return false;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '이 앱 화면에서 보낸 요청만 받습니다', detail: why }));
  req.resume();
  return true;
}
