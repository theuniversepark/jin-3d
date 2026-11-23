// 불량 판정 리포트 전송 · RCA 서버 연동 검증 — 검사셀 엣지 → MQTT 브로커 → 메인 서버 → (HTTP) RCA 서버 → 분석 결과(MQTT) → 봉쇄 지시 → 수신 확인 → 8D 종결 보고,
// 품질 통신 pcap(체크섬 · MQTT 토픽 · HTTP 요청/응답 짝 · 사례별 추출), 더미 RCA 서버 REST(server/rca-api.mjs) 규칙을 확인한다. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { QTOPIC } from '../js/qcomm.js';
import { makeRcaApi } from '../server/rca-api.mjs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 불량 판정 리포트 흐름 (피지컬AI 3시간)');
const s = new Simulation('dark', 5, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); s.capa.auto = true;
s.mode = { ...s.mode, defectBase: s.mode.defectBase * 4 };   // 실제 작업 시간(1.0.45)은 생산이 느려 불량 사례가 드물다 — 리포트 흐름을 보려고 불량률만 올린다
// 사례별 pcap이 전체의 일부인지 보려면 사례가 2건 이상, 8D 종결 보고를 보려면 종결된 사례가 1건 이상 있어야 한다 — 3시간에 모자라면(난수 흐름에 따라) 6시간까지 더 돌린다
const closedN = () => [...s.qcomm.cases.values()].filter((x) => x.status === 'closed').length;
for (let t = 0; t < 3 * 3600 || ((s.trace.cases.length < 2 || !closedN()) && t < 6 * 3600); t += 0.1) { s.step(0.1); ag.update(0.1); }
const Q = s.qcomm, cms = [...Q.cases.values()], cm = cms[0];
check('불량 사례마다 리포트 전송', cms.length > 0 && cms.length === s.trace.cases.length, `사례 ${s.trace.cases.length} · 리포트 ${cms.length}`);
const kinds = cm.msgs.map((m) => `${m.proto}:${m.ref.replace(/NG-\d+-\d+|RCA-\d+-\d+/g, '#')}`);
check('① 엣지 → 메인 서버 MQTT (불량 판정 리포트)', kinds[0] === 'MQTT:metafactory/quality/v1/defect/main/' + cm.edge.st, kinds[0]);
check('② 메인 서버 → RCA 서버 HTTP POST · 202 티켓', kinds[1] === 'HTTP:POST /api/rca/v1/reports' && /^RCA-\d{8}-\d{4}$/.test(cm.ticket), cm.ticket);
check('③ RCA 결과 · ④ 봉쇄 지시 · 수신 확인 (MQTT)', kinds.slice(2, 5).join(' | ') === 'MQTT:metafactory/quality/v1/rca/#/result | MQTT:metafactory/quality/v1/action/' + cm.edge.st + ' | MQTT:metafactory/quality/v1/ack/#', kinds.slice(2, 5).join(' | '));
const closed = cms.filter((x) => x.status === 'closed'), capaDone = s.capa.list.filter((k) => k.status === 'closed' || k.status === 'held');
check('⑤ 8D 종결 → RCA 서버 종결 보고 (HTTP)', closed.length > 0 && closed.every((x) => x.msgs.at(-1).ref.endsWith('/close')) && Q.core.stats().byStatus.closed === closed.length, `종결 8D ${capaDone.length} · 종결 보고 ${closed.length}`);
check('리포트에 계보 정답 라벨(불량이 생긴 셀) 없음', cms.every((x) => !JSON.stringify(x.report).includes('"defect":') && !('truth' in x.report)));
check('RCA 결과: 우선순위 · 원인 · 봉쇄 · 대책 기한', cms.every((x) => !x.result || (['P1', 'P2', 'P3'].includes(x.result.priority) && x.result.containment.length && x.result.actions.every((a) => a.due))));

console.log('== 품질 통신 pcap');
const file = Q.pcap(), one = Q.pcap(cm.id), dv = new DataView(file.buffer);
check('libpcap 헤더 · 사례별 추출이 전체의 일부', dv.getUint32(0, true) === 0xa1b2c3d4 && one.length > 24 && (cms.length > 1 ? one.length < file.length : one.length <= file.length),   /* 실제 작업 시간(1.0.45): 사례가 1건뿐이면 전체 = 그 사례 */ `전체 ${(file.length / 1024).toFixed(0)}KB · 사례 ${(one.length / 1024).toFixed(0)}KB`);
const cs = (b, s0, e0, init = 0) => { let x = init; for (let i = s0; i < e0; i += 2) x += (b[i] << 8) + (i + 1 < e0 ? b[i + 1] : 0); while (x >> 16) x = (x & 0xffff) + (x >> 16); return x; };
let o = 24, n = 0, bad = 0, http = { req: 0, res: 0 }; const topics = new Set(), dec = new TextDecoder(), streams = new Map();
const odv = new DataView(one.buffer);
while (o < one.length) {
  const len = odv.getUint32(o + 8, true), f = one.subarray(o + 16, o + 16 + len); o += 16 + len; n++;
  const ip = 14, ihl = (f[ip] & 15) * 4, tot = (f[ip + 2] << 8) | f[ip + 3], tcp = ip + ihl, thl = (f[tcp + 12] >> 4) * 4;
  if ((~cs(f, ip, ip + ihl) & 0xffff) !== 0) bad++;
  const pseudo = cs(Uint8Array.from([...f.subarray(ip + 12, ip + 20), 0, 6, ((tot - ihl) >> 8) & 255, (tot - ihl) & 255]), 0, 12);
  if ((~cs(f, tcp, ip + tot, pseudo) & 0xffff) !== 0) bad++;
  const sp = (f[tcp] << 8) | f[tcp + 1], dp = (f[tcp + 2] << 8) | f[tcp + 3], pl = f.subarray(tcp + thl, ip + tot);
  if (!pl.length) continue;
  if (dp === 8080 || sp === 8080) { const k = `${sp}-${dp}`; streams.set(k, (streams.get(k) ?? '') + dec.decode(pl.subarray(0, 64))); }
  if (dp === 1883 && (pl[0] >> 4) === 3) { let i = 1, m = 1, v = 0, b; do { b = pl[i++]; v += (b & 127) * m; m *= 128; } while (b & 128); const tl = (pl[i] << 8) | pl[i + 1]; const tp = dec.decode(pl.subarray(i + 2, i + 2 + tl)); if (/^[\w/+#.-]+$/.test(tp)) topics.add(tp); }   // 분할 전송의 뒤 세그먼트(헤더 없음)는 건너뛴다
}
for (const v of streams.values()) { if (/^POST \/api\/rca\/v1\/reports/.test(v)) http.req++; if (/^HTTP\/1\.1 20[02]/.test(v)) http.res++; }
check('IPv4 · TCP 체크섬 (사례 pcap)', bad === 0, `패킷 ${n}개`);
check('MQTT 품질 토픽 (리포트 · 결과 · 조치 · 확인)', [QTOPIC.defect('main', cm.edge.st), QTOPIC.result(cm.id), QTOPIC.action(cm.edge.st), QTOPIC.ack(cm.id)].every((t) => topics.has(t)), [...topics].join(' · '));
check('HTTP 요청 ↔ 응답 짝 (RCA 서버 :8080)', http.req >= 1 && http.res >= http.req, `요청 ${http.req} · 응답 ${http.res}`);

console.log('== 더미 RCA 서버 REST (server/rca-api.mjs)');
const api = makeRcaApi(), q = new URLSearchParams();
const rep = { caseId: 'NG-T-1', serial: 'S1', detectedAt: 'CL-03', inspection: { mode: 'x' }, rca: { confidence: 0.4, causes: [{ station: 'DT_ASSY', factor: 'drift', label: 'A', score: 0.4 }, { station: 'SORT', factor: 'health', label: 'B', score: 0.35 }] }, suspects: [] };
const r1 = api.route('POST', '/api/rca/v1/reports', q, JSON.stringify(rep)), r2 = api.route('POST', '/api/rca/v1/reports', q, JSON.stringify(rep)), r3 = api.route('POST', '/api/rca/v1/reports', q, '{"serial":"x"}');
check('접수 202 · 같은 사례는 같은 티켓 · 필수 항목 없으면 422', r1.code === 202 && r2.code === 200 && r2.body.ticket === r1.body.ticket && r3.code === 422, `${r1.body.ticket}`);
const v = api.core.analyze(r1.body.ticket, new Date().toISOString());
check('신뢰도 낮으면 원인 재검토 · 대안 원인 · P2', v.result.review && v.result.rootCause.status === '재검토 필요' && v.result.alternative?.label === 'B' && v.result.priority === 'P2');
for (let i = 2; i <= 3; i++) api.core.analyze(api.route('POST', '/api/rca/v1/reports', q, JSON.stringify({ ...rep, caseId: `NG-T-${i}` })).body.ticket, new Date().toISOString());
const last = api.route('GET', `/api/rca/v1/reports/RCA-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-0003`, q, '');
check('같은 원인 3건째 → P1 · 관련 티켓', last.body.result?.priority === 'P1' && last.body.result.recurrence === 3 && last.body.result.related.length === 2);
const cl = api.route('POST', `/api/rca/v1/reports/${r1.body.ticket}/close`, q, '{"capa":"CAPA-001"}'), st = api.route('GET', '/api/rca/v1/status', q, '');
check('종결 200 · 상태 집계', cl.code === 200 && cl.body.status === 'closed' && st.body.reports === 3 && st.body.byStatus.closed === 1, JSON.stringify(st.body.byStatus));

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
