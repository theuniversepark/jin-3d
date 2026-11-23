// 마무리 리뷰 수정 확인 — 서버 보안: 루프백 Host · 다른 웹페이지 요청 차단(실제 서버에 요청) · 연동 키 암호화 보관(server/secrets.mjs)
// · 추적·품질 연동: RCA 실행 구분 · 실행 ID · ERPNext 대기열/EPCIS 이벤트 파일 복구 · EPCIS 외부 전송(처리 중 확정 보류 · 처음부터 다시 보내기 세대). 실행: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { rejectReason, isLoopbackHost } from '../server/http-guard.mjs';
import { configFile, setSecretCodec, secretsEncrypted, writePrivate } from '../server/secrets.mjs';
import { makeErpBridge } from '../server/erpnext-bridge.mjs';
import { makeEpcisApi } from '../server/epcis-api.mjs';
import { RcaCore } from '../js/rcacore.js';
import { DataHub } from '../js/datahub.js';
import { Simulation } from '../js/sim.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-finalfix-'));

console.log('== 루프백 Host — 실제 127.x IPv4만');
{
  const req = (host) => rejectReason({ headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } });
  check('127.attacker.example 거부', req('127.attacker.example:47615') !== null);
  check('127.0.0.1 · 127.1.2.3 · localhost · [::1] 허용', [req('127.0.0.1:47615'), req('127.1.2.3:47615'), req('localhost:47615'), req('[::1]:47615')].every((x) => x === null));
  check('127.0.0.1.nip.io 거부 · 서버 주소 판정도 같음', req('127.0.0.1.nip.io:47615') !== null && !isLoopbackHost('127.evil.example') && isLoopbackHost('127.0.0.1'));
}

console.log('== 다른 웹페이지 요청 차단 — 실제 서버');
{
  process.env.JIN3D_DATA_DIR = path.join(tmp, 'data');
  const { startServer } = await import('../server/app-server.mjs');
  const { port, server } = await startServer({ port: 0 });
  // fetch는 Host · Sec-Fetch-* 를 바꿀 수 없어 http.request로 헤더를 그대로 보낸다
  const call = (p, headers = {}, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ code: res.statusCode, text: t })); });
    r.on('error', reject); r.end(body);
  });
  const me = `http://127.0.0.1:${port}`;
  const ok1 = await call('/api/status'), ok2 = await call('/api/status', { origin: me, 'sec-fetch-site': 'same-origin' }), ok3 = await call('/index.html', { 'sec-fetch-site': 'none' }), ok4 = await call('/api/status', { host: `localhost:${port}`, origin: `http://localhost:${port}` });
  check('출처 헤더 없는 요청(curl · MES) · 이 앱 화면 요청 · 주소창 직접 열기 · localhost 통과', [ok1, ok2, ok3, ok4].every((r) => r.code === 200), [ok1, ok2, ok3, ok4].map((r) => r.code).join(','));
  const bad = await Promise.all([
    call('/api/status', { origin: 'https://evil.example' }),
    call('/api/status', { origin: 'null' }),
    call('/api/status', { origin: `http://127.0.0.1:${port + 1}` }),   // 같은 PC의 다른 포트 페이지
    call('/api/status', { 'sec-fetch-site': 'cross-site' }),   // <img> · <form> 처럼 Origin 없이 오는 요청
    call('/api/status', { 'sec-fetch-site': 'same-site' }),
    call('/api/status', { host: `evil.example:${port}` }),   // DNS 리바인딩
    call('/api/status', { host: `127.attacker.example:${port}` }),
    call('/index.html', { host: 'evil.example' }),
  ]);
  check('다른 출처 · null 출처 · 다른 포트 · cross-site · same-site · 남의 Host는 403', bad.every((r) => r.code === 403), bad.map((r) => r.code).join(','));
  const post = (headers) => call('/api/fac/push', { 'content-type': 'application/json', ...headers }, 'POST', JSON.stringify({ run: 'run-guard', events: [{ type: 'po.create', key: 'PO-1' }] }));
  const pBad = await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), st0 = JSON.parse((await call('/api/fac/status')).text);
  const pOk = await post({ origin: me, 'sec-fetch-site': 'same-origin' }), st1 = JSON.parse((await call('/api/fac/status')).text);
  check('다른 사이트의 POST는 처리 전에 거부 (기록이 생기지 않음) · 이 앱 화면의 POST는 처리', pBad.code === 403 && st0.active === false && pOk.code === 200 && st1.seq === 1, `${pBad.code} · ${pOk.code} · seq ${st1.seq}`);
  const ag = await call('/api/agent', { origin: 'https://evil.example', 'content-type': 'application/json' }, 'POST', '{}'), ln = await call('/api/line', { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, 'POST', '{}');
  check('Claude 호출 경로(/api/agent · /api/line)도 다른 사이트 요청은 403 (키 유무 확인 전에)', ag.code === 403 && ln.code === 403, `${ag.code},${ln.code}`);
  const body = JSON.parse(bad[0].text);
  check('거부 응답에 사유', /이 앱 화면/.test(body.error) && /evil\.example/.test(body.detail), body.detail);
  server.close(); server.closeAllConnections?.();
}

console.log('== 연동 키 보관 — 암호기가 있으면 암호문만, 없으면 평문 0600');
{
  const file = path.join(tmp, 'config.json'), mode = (f) => fs.statSync(f).mode & 0o777;
  setSecretCodec(null);
  let c = configFile(file, { url: '', apiKey: '' }, ['apiKey']); c.cfg.url = 'https://erp.example'; c.cfg.apiKey = 'plain-secret'; c.save();
  check('암호기 없는 실행: 평문 · 이 계정만 읽기(0600) · 임시 파일 안 남음', !secretsEncrypted() && JSON.parse(fs.readFileSync(file, 'utf8')).apiKey === 'plain-secret' && (process.platform === 'win32' || mode(file) === 0o600) && !fs.readdirSync(tmp).some((f) => f.endsWith('.tmp')));
  // 시험용 암호기 (앱에서는 electron safeStorage)
  const codec = { encrypt: (t) => Buffer.from(`k1:${t}`).toString('base64'), decrypt: (b) => { const s = Buffer.from(b, 'base64').toString(); if (!s.startsWith('k1:')) throw new Error('다른 키'); return s.slice(3); } };
  setSecretCodec(codec);
  c = configFile(file, { url: '', apiKey: '' }, ['apiKey']);
  const raw1 = fs.readFileSync(file, 'utf8');
  check('암호기 있는 실행에서 처음 읽으면 평문 파일을 암호문으로 바꿔 씀 · 값은 그대로', secretsEncrypted() && c.cfg.apiKey === 'plain-secret' && !raw1.includes('plain-secret') && JSON.parse(raw1).apiKey.startsWith('enc:') && JSON.parse(raw1).url === 'https://erp.example');
  c.save();
  check('다시 저장해도 파일이 바뀌지 않음', fs.readFileSync(file, 'utf8') === raw1);
  // 다른 계정·다른 PC의 암호문: 풀 수 없으면 비운 값으로 읽되 파일의 암호문은 그대로 둔다
  setSecretCodec({ encrypt: (t) => Buffer.from(`k2:${t}`).toString('base64'), decrypt: (b) => { const s = Buffer.from(b, 'base64').toString(); if (!s.startsWith('k2:')) throw new Error('다른 키'); return s.slice(3); } });
  c = configFile(file, { url: '', apiKey: '' }, ['apiKey']); c.cfg.url = 'https://erp2.example'; c.save();
  check('풀 수 없는 암호문은 지우지 않고 보존 (값은 빈 칸 · 잠김 표시)', c.cfg.apiKey === '' && c.locked('apiKey') && JSON.parse(fs.readFileSync(file, 'utf8')).apiKey === JSON.parse(raw1).apiKey && JSON.parse(fs.readFileSync(file, 'utf8')).url === 'https://erp2.example');
  c.forget('apiKey'); c.save();
  check('forget — 비밀 값 삭제', JSON.parse(fs.readFileSync(file, 'utf8')).apiKey === '' && !c.locked('apiKey'));
  setSecretCodec(null);
  const pf = path.join(tmp, 'p.txt'); writePrivate(pf, 'x');
  check('writePrivate — 0600', process.platform === 'win32' || mode(pf) === 0o600);
}

console.log('== RCA — 같은 사례 번호라도 실행이 다르면 새 티켓');
{
  const core = new RcaCore(), day = '2026-10-23T00:00:00Z';
  const rep = (runId, serial) => ({ runId, caseId: 'NG-261023-0001', serial, detectedAt: 'DT_FAST', inspection: { result: 'NG' } });
  const a = core.receive(rep('run-A', 'S-A'), day), a2 = core.receive(rep('run-A', 'S-A'), day), b = core.receive(rep('run-B', 'S-B'), day);
  check('같은 실행 재전송 → 같은 티켓 (200)', a2.code === 200 && a2.body.ticket === a.body.ticket);
  check('다른 실행 → 새 티켓 (202) · 제품 식별자 보존', b.code === 202 && b.body.ticket !== a.body.ticket && core.reports.get(b.body.ticket).report.serial === 'S-B', `${a.body.ticket} / ${b.body.ticket}`);
}

console.log('== 실행 ID — 같은 초에 두 번 시작해도 다름 · 저장 ID 형식 안');
{
  const s = new Simulation('smart', 1, { quiet: true }), H = new DataHub();
  H.reset(s, null); const x = H.runId; H.reset(s, null); const y = H.runId;
  check('연속 reset의 실행 ID가 다름', x !== y, `${x} / ${y}`);
  check('서버 저장 ID 규칙(64자 · 영숫자_.-) 안', [x, `${y}_robotcam_0001`].every((v) => /^[A-Za-z0-9_.-]{1,64}$/.test(v)));
}

console.log('== ERPNext 대기열 — 끝 줄이 깨져도 정상 줄 복구');
{
  const dir = path.join(tmp, 'erp'); fs.mkdirSync(dir);
  const good = (k) => JSON.stringify({ run: 'run-A', e: { type: 'po.create', key: k, lines: [] } });
  fs.writeFileSync(path.join(dir, 'queue.jsonl'), `${good('PO-1')}\n{broken\n${good('PO-2')}\n{"run":`);
  const erp = makeErpBridge({ dir, interval: 1e9 }), st = erp.status(); erp.close();
  check('정상 2줄 + 깨진 중간 줄 자리 = 대기 3건', st.queued === 3, `queued ${st.queued}`);
  check('복구 내용을 상태에 알림', st.recovery?.bad === 1 && !!st.recovery?.torn && /복구/.test(st.lastError ?? ''), st.lastError ?? '');
  const text = fs.readFileSync(path.join(dir, 'queue.jsonl'), 'utf8');
  check('끝 조각을 잘라 줄 경계 맞춤 · 조각은 따로 보관', text.endsWith('\n') && !text.includes('{"run":\n') && fs.existsSync(st.recovery.torn));
  const tmpLeft = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  check('임시 파일이 남지 않음', tmpLeft.length === 0);
}

console.log('== EPCIS 이벤트 파일 — 끝 조각 뒤에 붙은 새 이벤트도 다음 재시작에 남음');
{
  const dir = path.join(tmp, 'epcis'); fs.mkdirSync(dir);
  const event = (id) => ({ type: 'ObjectEvent', eventID: `urn:uuid:${id}`, eventTime: '2026-10-23T00:00:00Z', eventTimeZoneOffset: '+09:00', epcList: ['urn:epc:id:sgtin:8800000.000001.DT-261023-000001'], action: 'OBSERVE', bizStep: 'storing' });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ...event('before-crash'), _seq: 1 }) + '\n{"type":');
  const api = makeEpcisApi({ dir, interval: 1e9 });
  const rec = api.status().recovery;
  await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify([event('after-restart')]));
  api.close(); await new Promise((r) => setTimeout(r, 100));
  const next = makeEpcisApi({ dir, interval: 1e9 }), ids = next.store.events.map((e) => e.eventID); next.close();
  check('재시작 뒤 두 이벤트 모두 있음', ids.includes('urn:uuid:before-crash') && ids.includes('urn:uuid:after-restart'), ids.join(', '));
  check('복구 내용을 상태에 알림', !!rec?.torn);
}

console.log('== EPCIS 외부 전송 — 처리 중인 작업은 끝날 때까지 확정하지 않음');
{
  const dir = path.join(tmp, 'epcis-fw'); fs.mkdirSync(dir);
  let running = true, captures = 0;
  const api = makeEpcisApi({ dir, interval: 1e9, fetchImpl: async (url) => {
    if (url.includes('userExtension')) return new Response('', { status: 404 });
    if (url.endsWith('/capture')) { captures++; return new Response('', { status: 202, headers: { Location: '/capture/job-1' } }); }
    return new Response(JSON.stringify(running ? { running: true } : { running: false, success: true, captureID: 'job-1', errors: [] }), { status: 200 });
  } });
  await api.route('POST', '/api/epcis/v1/config', new URLSearchParams(), JSON.stringify({ url: 'https://repository.example', enabled: true }));
  await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify([{ type: 'ObjectEvent', eventID: 'urn:uuid:fw-1', eventTime: '2026-10-23T00:00:00Z', eventTimeZoneOffset: '+09:00', epcList: ['urn:test:unit'], action: 'ADD' }]));
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };   // 조회 대기 시간만 건너뜀
  try {
    await api.pump(); const s1 = api.status().forward;
    check('처리 중 → 보낸 위치 유지 (대기 1 · 보냄 0)', s1.pending === 1 && s1.sent === 0 && !!s1.processing, s1.lastError ?? '');
    running = false;
    const realNow = Date.now; Date.now = () => realNow() + 2e9;   // 다음 주기 (처리 중 확인 간격이 지남)
    try { await api.pump(); await api.pump(); } finally { Date.now = realNow; }
    const s2 = api.status().forward;
    check('다음 주기에 같은 작업이 끝남 확인 → 확정 (다시 보내지 않음)', s2.pending === 0 && s2.sent === 1 && captures === 1 && s2.lastJob?.success === true, `capture ${captures}회`);
  } finally { globalThis.setTimeout = realTimeout; api.close(); }
}

console.log('== EPCIS — 처리 중에 「처음부터 다시」를 눌러도 앞 이벤트를 다시 보냄');
{
  let done = true; const captures = [];
  const api = makeEpcisApi({ dir: path.join(tmp, 'epcis-rewind'), interval: 1e9, fetchImpl: async (url, opts) => {
    if (url.includes('userExtension')) return new Response('', { status: 404 });
    if (url.endsWith('/capture')) { captures.push(JSON.parse(opts.body).epcisBody.eventList.map((e) => e.eventID)); return new Response('', { status: 202, headers: { Location: '/capture/job' } }); }
    return Response.json(done ? { running: false, success: true, errors: [] } : { running: true });
  } });
  const config = (b) => api.route('POST', '/api/epcis/v1/config', new URLSearchParams(), JSON.stringify(b));
  const capture = (id) => api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify([{ type: 'ObjectEvent', eventID: `urn:uuid:${id}`, eventTime: '2026-10-23T00:00:00Z', eventTimeZoneOffset: '+09:00', epcList: ['urn:test:unit'], action: 'ADD' }]));
  const realTimeout = globalThis.setTimeout, realNow = Date.now;
  globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
  try {
    await config({ url: 'https://repository.example', enabled: true });
    await capture('history'); await api.pump();
    done = false; await capture('pending'); await api.pump();
    await config({ fromStart: true });
    done = true; Date.now = () => realNow() + 2e9;
    await api.pump(); await api.pump();
    const after = api.status().forward;
    check('처음부터 다시 → 두 이벤트를 다시 보내 대기 0', after.pending === 0 && captures.length === 3 && captures[2].join() === 'urn:uuid:history,urn:uuid:pending', JSON.stringify(captures));
  } finally { globalThis.setTimeout = realTimeout; Date.now = realNow; api.close(); }
}
{
  // 보내는 도중(응답 대기)에 「처음부터 다시」 — 늦게 온 응답이 새 커서를 덮어쓰지 않음
  let release; const gate = new Promise((r) => { release = r; });
  const api = makeEpcisApi({ dir: path.join(tmp, 'epcis-race'), interval: 1e9, fetchImpl: async (url) => {
    if (url.includes('userExtension')) return new Response('', { status: 404 });
    if (url.endsWith('/capture')) { await gate; return new Response('', { status: 200 }); }
    return Response.json({ running: false, success: true });
  } });
  await api.route('POST', '/api/epcis/v1/config', new URLSearchParams(), JSON.stringify({ url: 'https://repository.example', enabled: true }));
  await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify([{ type: 'ObjectEvent', eventID: 'urn:uuid:race', eventTime: '2026-10-23T00:00:00Z', eventTimeZoneOffset: '+09:00', epcList: ['urn:test:unit'], action: 'ADD' }]));
  const p = api.pump(); await new Promise(setImmediate);
  await api.route('POST', '/api/epcis/v1/config', new URLSearchParams(), JSON.stringify({ fromStart: true }));
  release(); await p;
  check('보내는 도중 「처음부터 다시」 → 늦은 응답이 커서를 옮기지 않음', api.status().forward.pending === 1);
  api.close();
}

console.log('== 센서 서버 — 다시 켠 뒤 정상값이 오면 이전 경보 해제');
{
  const source = fs.readFileSync(new URL('../server/sensor-server.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const arg ='), source.indexOf('// ── MQTT 구독')).replaceAll('export function ', 'function ');
  const factory = new Function('fs', 'path', 'DatabaseSync', 'process', 'setInterval', body + '\nreturn { ingest, route, close: () => db.close() };');
  const make = () => factory(fs, path, DatabaseSync, { argv: [], env: { SENSOR_DB: path.join(tmp, 'sensors.db') } }, () => ({ unref() {} }));
  const birth = { zone: 'main', cell: 'C1', cellName: 'cell', edge: 'edge', gateway: 'gw', zoneServer: 'zone', sensors: [{ id: 'S1', type: 'temp', cat: 'env', label: 'Temp', metric: 'temp', unit: 'C', iface: 'wired', rate: 1, x: 0, z: 0, warn: { hi: 5 }, alarm: { hi: 10 } }] };
  const batch = (v, ts) => ({ spec: 'metafactory/sensor-batch/1.0', run: 't', seq: ts, zone: 'main', cell: 'C1', edge: 'edge', gateway: 'gw', zoneServer: 'zone', hops: { edge: ts, gateway: ts, zone: ts, central: ts, ingest: ts }, readings: [{ s: 'S1', m: 'temp', v, u: 'C', ts, e: 0 }] });
  let S = make(); S.ingest('metafactory/sensors/v1/main/C1/birth', JSON.stringify(birth)); S.ingest('metafactory/sensors/v1/main/C1', JSON.stringify(batch(20, 1e6))); S.close();
  S = make(); S.ingest('metafactory/sensors/v1/main/C1', JSON.stringify(batch(1, 2e6)));
  const active = S.route('GET', '/api/sensors/v1/alarms', new URLSearchParams({ active: '1' })).body.alarms; S.close();
  check('활성 경보 0', active.length === 0, `활성 ${active.length}`);
}


fs.rmSync(tmp, { recursive: true, force: true });
console.log(`결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
