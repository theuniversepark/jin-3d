// EPCIS 2.0 저장소 검증 (js/epcis.js · server/epcis-api.mjs) — 시리얼 서비스 이벤트가 GS1 EPCIS 2.0 공식 JSON 스키마를 통과하는지,
// 저장소 캡처(eventID 중복 제거)·질의·추적 사슬·리콜 범위, 앱 내장 저장소 파일 보관·다시 켜기, 외부 저장소 전송(확장 스키마 등록 · 끊김 → 밀린 것 재전송),
// 시리얼 번호 이어 받기(재사용 금지)가 맞는지. 실행: npm test  (공식 스키마는 처음 한 번 ref.gs1.org에서 받아 tests/.cache에 둔다 — 받을 수 없으면 그 검사만 건너뜀)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { EpcisStore, epcisEvent, epcisDocument, ssccEpc } from '../js/epcis.js';
import { makeEpcisApi } from '../server/epcis-api.mjs';
let pass = 0, fail = 0, skip = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
const iso = (t) => new Date(Date.UTC(2026, 9, 22) + t * 1000).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('== 시리얼 서비스 이벤트 → EPCIS 2.0 (자동화 · 정밀조립 2시간 + 샘플 NG)');
const s = new Simulation('smart', 4, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), H = s.serials;
H.feedOn = true;
run(s, ag, 5400);
for (let k = 0; k < 180 && !(H.fg.doortrim ?? []).some((u) => !u.hold); k++) run(s, ag, 10);   // 샘플로 꺼낼 도어트림 완제품이 적재장에 있을 때 (방금 출하로 비었으면 잠깐 더)
{ const req = { id: 'QS-E1', zone: 'main', product: 'doortrim', t0: s.time }, smp = H.sample(req); smp.status = 'escaped'; s.trace.stats.ok--; s.trace.stats.escaped++; H.judge(req); run(s, ag, 1800); }   // 출하 전 샘플 재검 NG (샘플 = 시험용 유출 불량) → 봉쇄 · 처분
const raw = H.drain(), evs = raw.map((e) => epcisEvent(H, e, iso)).filter(Boolean), doc = epcisDocument(evs, iso(s.time));
const by = (b) => evs.filter((e) => e.bizStep === b);
check('발행 이후 이벤트만 (WIP 단계 없음) · 발행 · 적재 · 팔레트 묶음 · 출하 · 보류 · 해제', ['commissioning', 'storing', 'packing', 'shipping', 'holding', 'inspecting'].every((b) => by(b).length) && evs.every((e) => (e.epcList ?? e.childEPCs ?? []).every((x) => !x.startsWith('urn:mf:wip'))), ['commissioning', 'storing', 'packing', 'shipping', 'holding', 'inspecting', 'repairing', 'decommissioning'].map((b) => `${b} ${by(b).length}`).join(' · '));
check('eventID = urn:uuid · 모두 다름 · 위치 SGLN(점 없는 확장) · 출하 = SSCC EPC + 트럭 bizTransaction(bol)', evs.every((e) => /^urn:uuid:[0-9a-f-]{36}$/.test(e.eventID)) && new Set(evs.map((e) => e.eventID)).size === evs.length && evs.every((e) => !e.readPoint || /^urn:epc:id:sgln:8800000\.00001\.[A-Za-z0-9-]+$/.test(e.readPoint.id)) && by('shipping').every((e) => /^urn:epc:id:sscc:8800000\.\d{10}$/.test(e.epcList[0]) && e.bizTransactionList[0].type === 'bol'));
check('보류 이벤트에 보류된 시리얼 EPC 목록 (빈 epcList 없음)', evs.every((e) => e.type !== 'ObjectEvent' || e.epcList.length > 0) && by('holding').every((e) => e.epcList.every((x) => x.startsWith('urn:epc:id:sgtin:'))));
{ const cache = path.resolve('tests/.cache/epcis-json-schema.json');
  let schema = null;
  try { schema = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {
    try { const r = await fetch('https://ref.gs1.org/standards/epcis/epcis-json-schema.json', { signal: AbortSignal.timeout(15000) }); if (r.ok) { schema = await r.json(); fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify(schema)); } } catch { /* 오프라인 */ }
  }
  if (!schema) { skip++; console.log('  SKIP  GS1 EPCIS 2.0 공식 JSON 스키마 검증 — 스키마를 받을 수 없음 (오프라인)'); }
  else {
    const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
    const v = ajv.compile(schema), ok = v(doc);
    check(`GS1 EPCIS 2.0 공식 JSON 스키마 통과 (${schema.$id?.match(/\d\.\d\.\d/)?.[0] ?? ''}) — 문서 ${evs.length}건`, ok, ok ? '' : JSON.stringify(v.errors.slice(0, 3)));
  }
}

console.log('== 저장소 (캡처 · 질의 · 추적 사슬 · 리콜 범위)');
const st = new EpcisStore();
{ const j1 = st.capture(doc), j2 = st.capture(doc);
  check('캡처 → 접수 · 같은 eventID 다시 보내면 중복 제외', j1.accepted === evs.length && j2.accepted === 0 && j2.duplicate === evs.length && st.count === evs.length, `${j1.accepted} / 재전송 중복 ${j2.duplicate}`);
  const bad = st.capture([{ type: 'ObjectEvent', eventTime: iso(1), eventTimeZoneOffset: '+09:00', epcList: ['not a uri'] }, { type: 'Nope' }]);
  check('잘못된 이벤트는 거부 사유와 함께 (캡처 작업 errors)', bad.accepted === 0 && bad.errors.length === 2 && !bad.success);
  const shipped = H.units.find((u) => u.loc === 'shipped' && u.ship?.truck), chain = st.trace(shipped.epc).map((e) => e.bizStep);
  check('시리얼 추적 사슬: 발행 → 적재 → 팔레트 묶음(SSCC) → 출하', ['commissioning', 'storing', 'packing', 'shipping'].every((b, i, A) => chain.indexOf(b) >= 0 && (i === 0 || chain.indexOf(b) > chain.indexOf(A[i - 1]))), `${shipped.serial}: ${chain.join(' → ')}`);
  const R = st.shipmentOf(shipped.ship.shipment), truckUnits = H.units.filter((u) => u.ship?.shipment === shipped.ship.shipment).map((u) => u.epc);
  check('리콜 범위: 출하 ID → 팔레트 SSCC → 시리얼 (시리얼 서비스 기록과 일치) · 트럭 표시 이름', /^SHP-\d{6}-\d{5}$/.test(shipped.ship.shipment) && R.truck === shipped.ship.truck && R.serials.length === truckUnits.length && truckUnits.every((x) => R.serials.includes(x)) && R.pallets.includes(ssccEpc(shipped.ship.sscc)), `${shipped.ship.truck} ${shipped.ship.shipment}: 팔레트 ${R.pallets.length} · 시리얼 ${R.serials.length}`);
  const q1 = st.query({ MATCH_anyEPC: shipped.epc }), q2 = st.query({ EQ_bizStep: 'shipping', perPage: 2 }), q3 = st.query({ EQ_bizStep: 'shipping', perPage: 2, nextPageToken: q2.nextPageToken });
  const L = (q) => q.epcisBody.queryResults.resultsBody.eventList;
  check('EPCIS 질의: MATCH_anyEPC · EQ_bizStep · perPage · nextPageToken · 결과 = EPCISQueryDocument', q1.type === 'EPCISQueryDocument' && L(q1).length >= 2 && L(q2).length === 2 && !!q2.nextPageToken && L(q3).length >= 1 && L(q3)[0].eventID !== L(q2)[0].eventID && L(q3).every((e) => e.bizStep === 'shipping'));
  const t0 = evs[Math.floor(evs.length / 2)].eventTime, q4 = L(st.query({ GE_eventTime: t0, perPage: 1000 })), q5 = L(st.query({ 'EQ_mf:truck': shipped.ship.truck }));
  check('질의: GE_eventTime · 확장 필드 EQ_mf:truck', q4.length > 0 && q4.every((e) => e.eventTime >= t0) && q5.length > 0 && q5.every((e) => e['mf:truck'] === shipped.ship.truck));
}

console.log('== 앱 내장 저장소 (server/epcis-api.mjs) · 외부 저장소 전송');
{ const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-epcis-')), q = (o = {}) => new URLSearchParams(o);
  const api = makeEpcisApi({ dir, interval: 150 });
  const r1 = await api.route('POST', '/api/epcis/v1/capture', q(), JSON.stringify(doc));
  const r2 = await api.route('GET', `/api/epcis/v1/capture/${r1.body.captureID}`, q(), '');
  check('POST /capture → 202 · 캡처 작업 조회', r1.code === 202 && r1.body.accepted === evs.length && r2.code === 200 && r2.body.success);
  api.close(); await wait(100);
  const api2 = makeEpcisApi({ dir, interval: 150 }), st2 = (await api2.route('GET', '/api/epcis/v1/status', q(), '')).body;
  const again = await api2.route('POST', '/api/epcis/v1/capture', q(), JSON.stringify(doc));
  check('앱을 다시 켜도 파일에서 그대로 · 같은 이벤트는 다시 쌓이지 않음', st2.events === evs.length && again.body.duplicate === evs.length && st2.file > 1000, `${st2.events}건 · ${Math.round(st2.file / 1024)}KB`);
  const sb = (await api2.route('GET', '/api/epcis/v1/serial-base', q({ ymd: H.ymd }), '')).body.base;
  check('시리얼 이어 받기: 저장소의 오늘 마지막 번호 (제품코드별)', sb.DT === H.serSeq.DT && sb.EA === H.serSeq.EA, JSON.stringify(sb));
  const tr = (await api2.route('GET', '/api/epcis/v1/trace', q({ epc: H.units.find((u) => u.loc === 'shipped').epc }), '')).body;
  check('GET /trace · /events (질의 문서)', tr.events.length >= 4 && (await api2.route('GET', '/api/epcis/v1/events', q({ EQ_bizStep: 'commissioning', perPage: 5 }), '')).body.epcisBody.queryResults.resultsBody.eventList.length === 5);
  // 가짜 외부 저장소 (OpenEPCIS 꼴): 확장 스키마 등록 · /capture · /events
  // 실제 OpenEPCIS CE에서 확인한 동작을 흉내: Accept가 application/json뿐이면 406 · 확장 스키마 재등록은 500 "already mapped" · 본문 50건 넘으면 413 · 비동기 캡처 작업(202 Location)
  const got = { capture: 0, events: 0, ext: 0, auth: null, proceed: 0, jobs: 0, n413: 0 }; let down = false, jobN = 0;
  const ext = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (down) { res.writeHead(503); return res.end(); }
    got.auth = req.headers.authorization ?? null;
    if (req.headers.accept === 'application/json') { res.writeHead(406); return res.end(); }
    if (req.url.startsWith('/userExtension/jsonSchema')) { got.ext++; if (got.ext > 1) { res.writeHead(500); return res.end('{"detail":"The given namespace and default prefix already mapped"}'); } res.writeHead(201); return res.end(); }
    if (req.url === '/capture' && req.method === 'POST') {
      const n = JSON.parse(b).epcisBody.eventList.length; if (n > 50) { got.n413++; res.writeHead(413); return res.end(); }
      if (req.headers['gs1-capture-error-behaviour'] === 'proceed') got.proceed++;
      got.capture += n; res.writeHead(202, { Location: `/capture/${++jobN}` }); return res.end();
    }
    if (/^\/capture\/\d+$/.test(req.url)) { got.jobs++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ captureID: req.url.slice(9), running: false, success: true, errors: req.url.endsWith('/2') ? [{ detail: 'Duplicate EPCIS Event' }] : [] })); }
    if (req.url.startsWith('/events')) { got.events++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"type":"EPCISQueryDocument"}'); }
    res.writeHead(404); res.end(); }); });
  await new Promise((r) => ext.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${ext.address().port}`;
  const t = (await api2.route('POST', '/api/epcis/v1/forward/test', q(), JSON.stringify({ url }))).body;
  const closed = await new Promise((r) => { const x = http.createServer(); x.listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => r(p)); }); });   // 방금 닫은 포트
  const bad = (await api2.route('POST', '/api/epcis/v1/forward/test', q(), JSON.stringify({ url: `http://127.0.0.1:${closed}` }))).body;
  check('연결 시험: 성공 · 실패(사람이 읽는 사유)', t.ok && !bad.ok && /연결 거부/.test(bad.error), bad.error);
  const c = (await api2.route('POST', '/api/epcis/v1/config', q(), JSON.stringify({ url, enabled: true, apiKey: 'tok-123' }))).body;
  for (let i = 0; i < 400 && (got.capture < evs.length || (await api2.route("GET", "/api/epcis/v1/status", q(), "")).body.forward.pending); i++) await wait(100);
  const fs1 = (await api2.route('GET', '/api/epcis/v1/status', q(), '')).body.forward;
  check('외부 전송: 확장 스키마(mf:) 등록 → /capture (proceed) → 캡처 작업 확인 · 413이면 묶음 축소 · 인증 토큰 · 응답에 토큰 값 없음', got.ext === 1 && got.capture === evs.length && got.n413 >= 1 && fs1.batch === 50 && got.proceed > 0 && got.jobs === got.proceed && got.auth === 'Bearer tok-123' && c.apiKey === true && !JSON.stringify(c).includes('tok-123'), `보냄 ${got.capture} · 묶음 ${fs1.batch} · 캡처 작업 ${got.jobs}`);
  check('중복 거부(Duplicate EPCIS Event)는 정상으로 · 거부 0', fs1.rejected === 0 && !fs1.lastError);
  down = true;
  await api2.route('POST', '/api/epcis/v1/capture', q(), JSON.stringify(epcisDocument(evs.slice(0, 3).map((e) => ({ ...e, eventID: e.eventID.replace(/.$/, 'f') + 'a' })), iso(1))));
  const extra = 3; for (let i = 0; i < 100; i++) { await wait(100); const f = (await api2.route("GET", "/api/epcis/v1/status", q(), "")).body.forward; if (f.lastError) break; }
  const sDown = (await api2.route('GET', '/api/epcis/v1/status', q(), '')).body.forward;
  down = false; for (let i = 0; i < 400 && (got.capture < evs.length + extra || (await api2.route("GET", "/api/epcis/v1/status", q(), "")).body.forward.pending); i++) await wait(150);
  const sUp = (await api2.route('GET', '/api/epcis/v1/status', q(), '')).body.forward;
  check('외부 저장소가 끊기면 대기 · 실패 사유 → 다시 연결되면 밀린 것 전송', sDown.pending === extra && !!sDown.lastError && got.capture === evs.length + extra && sUp.pending === 0, `끊김: 대기 ${sDown.pending} · ${sDown.lastError} → 복구 후 대기 ${sUp.pending}`);
  api2.close(); ext.close();
  const api3 = makeEpcisApi({ dir, interval: 150 }), s3 = (await api3.route('GET', '/api/epcis/v1/status', q(), '')).body.forward;
  check('보낸 위치를 기억 — 앱을 다시 켜도 처음부터 다시 보내지 않음 (토큰은 보관 · 응답에는 여부만)', s3.pending === 0 && s3.enabled && s3.apiKey === true);
  api3.close(); fs.rmSync(dir, { recursive: true, force: true });
}

console.log('== 시리얼 번호 이어 받기 (단계를 바꿔 새 시뮬레이션)');
{ const SEQ = {}, a = new Simulation('smart', 9, { line: zoneLine(), quiet: true }); a.serials.serSeq = SEQ; run(a, new FactoryAgent(a), 1200);
  const n1 = SEQ.DT ?? 0, last = a.trace.recent.filter((r) => r.serial && r.product === 'doortrim').at(-1)?.serial;
  const b = new Simulation('dark', 9, { line: zoneLine(), quiet: true }); b.serials.serSeq = SEQ; run(b, new FactoryAgent(b), 1200);
  const first = b.trace.recent.find((r) => r.serial && r.product === 'doortrim')?.serial;
  check('새 시뮬레이션의 첫 시리얼 = 이전 마지막 다음 번호 (같은 시리얼 재사용 없음)', n1 > 0 && Number(first?.slice(-6)) === n1 + 1, `${last} → ${first}`);
}
console.log(`결과: ${pass} PASS / ${fail} FAIL${skip ? ` / ${skip} SKIP` : ''}`);
process.exit(fail ? 1 : 0);
