// 데이터 보존 검증 (검수보고서 R04 · R05) — 실행: npm test
// R04 제품 식별 번호: 서버가 예약해 준 범위 안에서만 발행 (js/serialalloc.js · server/epcis-api.mjs serial-reserve)
//   ① 응답 지연 — 응답 전에는 발행 보류(1번부터 발행하지 않음) → 받으면 저장소의 오늘 마지막 번호 뒤부터  ② 요청 실패(HTTP 오류 · JSON 오류 응답 · 형식 오류) — 보류 + 다시 시도 + 상태 표시
//   ③ 서버 재시작 — 예약만 하고 이벤트를 못 올린 번호도 다시 나가지 않음  ④ 화면 여럿 · 앱 서버 둘 동시 실행 — 시리얼 · SSCC · 출하 ID 중복 0  ⑤ 범위 소진 — 보류했다가 이어서 발행
// R05 UNS 사건 전송: 대기함(outbox) + 성공 응답 뒤 확정 (js/uns.js · server/mqtt-gateway.mjs · server/facos-store.mjs)
//   ⑥ 전송 실패 → 다시 보내는 묶음에 결정 · A2A · 명령 · 현장 업링크가 그대로  ⑦ 응답만 유실 → 다시 보내도 서버 · FacOS 저장소에 한 번만  ⑧ r.ok=false · JSON 오류 응답 · 브로커 꺼짐 = 실패
//   ⑨ 상태 rebirth와 사건 재전송 분리  ⑩ 단계 전환 중 보존(이전 실행 ID로)  ⑪ 대기함 한도 + 버린 것 기록  ⑫ 평면 토픽(DataHub) · EPCIS 수집 · 화면 문구
// ⑬ 실제 앱 서버(startServer — Mosquitto · 센서 서버 포함)를 따로 띄워 같은 경로 확인 · 끝난 뒤 자식 프로세스가 남지 않는지
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { DataHub } from '../js/datahub.js';
import { epcisEvent, epcisDocument } from '../js/epcis.js';
import { UnsNamespace, unsPostVia, UNS_ROOT } from '../js/uns.js';
import { SerialAllocator } from '../js/serialalloc.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (s, ag, sec) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); } };
const freePort = () => new Promise((r) => { const v = net.createServer().listen(0, '127.0.0.1', () => { const p = v.address().port; v.close(() => r(p)); }); });
const newSim = (seed = 1, mode = 'dark') => new Simulation(mode, seed, { quiet: true, line: zoneLine() });
const iso = (t) => new Date(Date.UTC(2026, 10, 17) + t * 1000).toISOString();
const PACK = { cell: 'PACK', name: '검사·포장셀' };
const unit = (H, i, product = 'doortrim') => H.adopt({ wip: `WIP-${product === 'eaxle' ? 'EA' : 'DT'}-T-${i}`, product, status: 'ok' });
const dup = (a) => a.length - new Set(a).size;
// 사건 종류별 건수 (토픽으로)
const kinds = (msgs) => ({ decision: msgs.filter((m) => m.topic.includes('/_facos/decision/')).length, a2a: msgs.filter((m) => m.topic.includes('/_facos/a2a/')).length, cmd: msgs.filter((m) => /\/cmd(\/|$)/.test(m.topic)).length, field: msgs.filter((m) => m.topic.includes('/_field/')).length });
// 결정 · A2A · 명령 · 현장 업링크를 한꺼번에 만든다
let decN = 0;
function makeEvents(s, ag) {
  s.fos.decisions.unshift({ kind: `audit-${++decN}`, verdict: 'apply', t: s.time, text: `감사 결정 ${decN}` });
  s.fos.bus.send('zone:main', 'factory', 'status', { text: `감사 A2A ${decN}` });
  s.cmd.issue('SPEED', 'all', 75, { by: '시험', why: `감사 명령 ${decN}` });
  const ev = s.injectFieldEvent('smoke', 0, 9); s.detectFieldEvent(ev, '시험 카메라', 0.95);
  run(s, ag, 12);
}

// ── ⑬ 실제 앱 서버 (자식 프로세스로 실행 — 끝난 뒤 부모가 Mosquitto · 센서 서버가 남았는지 본다) ─────────────────
if (process.argv.includes('--server')) {
  const out = [], check = (name, ok, info = '') => out.push({ name, ok: !!ok, info: String(info) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin-datasafe-srv-'));
  process.env.JIN3D_DATA_DIR = tmp; process.env.MQTT_PORT = String(await freePort()); process.env.MQTT_HOST = '127.0.0.1';
  const { startServer } = await import('../server/app-server.mjs'), { stopMqtt } = await import('../server/mqtt-gateway.mjs');
  const { port, server } = await startServer({ port: 0 }), base = `http://127.0.0.1:${port}`, F = (u, o) => fetch(base + u, o);
  try {
    // 저장소에 오늘 번호 100까지
    const s0 = newSim(3), H0 = s0.serials; H0.feedOn = true;
    for (let i = 1; i <= 100; i++) H0.issue(unit(H0, i), PACK);
    const cap = await F('/api/epcis/v1/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(epcisDocument(H0.drain().map((e) => epcisEvent(H0, e, iso)).filter(Boolean), iso(0))) });
    check('실제 서버: 저장소에 오늘 시리얼 100건', cap.ok && (await (await F(`/api/epcis/v1/serial-base?ymd=${H0.ymd}`)).json()).base.DT === 100);
    // 화면 둘이 동시에 발행
    const mk = (seed) => { const s = newSim(seed), H = s.serials; H.useAllocator(H.serverAllocator(F)); return H; };
    const A = mk(5), B = mk(6), issued = [];
    check('실제 서버: 범위 응답 전에는 발행 보류', (() => { const u = unit(A, 0); A.issue(u, PACK); return u.serial === null && A.waitIssue.length === 1 && A.allocState().state === 'wait'; })());
    for (let i = 1; i <= 90; i++) { for (const H of [A, B]) { const u = unit(H, i, i % 3 ? 'doortrim' : 'eaxle'); H.issue(u, PACK); issued.push(u); } if (i % 7 === 0) await wait(5); A.update(); B.update(); }
    for (let k = 0; k < 200 && (A.waitIssue.length || B.waitIssue.length); k++) { await wait(10); A.update(); B.update(); }
    const ser = [...A.units, ...B.units].map((u) => u.serial), dt = ser.filter((x) => x?.startsWith('DT-')).map((x) => Number(x.slice(-6)));
    check('실제 서버: 화면 둘 동시 발행 — 시리얼 중복 0 · 모두 발행 · 저장소 마지막 번호(100) 뒤부터', ser.every(Boolean) && dup(ser) === 0 && Math.min(...dt) === 101, `${ser.length}개 · 중복 ${dup(ser)} · DT 최소 ${Math.min(...dt)}`);
    const bad = await F('/api/epcis/v1/serial-reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ymd: 'x', need: { 'ser:DT': 5 } }) });
    check('실제 서버: 잘못된 예약 요청은 JSON 오류 응답 (r.ok=false)', !bad.ok && !!(await bad.json()).error, bad.status);

    // UNS: 응답 유실 → 다시 보내도 FacOS 저장소에 한 번만
    const s = newSim(7), ag = new FactoryAgent(s); run(s, ag, 60); makeEvents(s, ag);
    const U = new UnsNamespace(s, { run: () => 'run-SRV1', iso });
    const lostReply = async (u, o) => { await F(u, o); throw new Error('응답 유실 (시험)'); };
    const r1 = await U.send(unsPostVia(lostReply)), held = U.outbox.length, K = kinds(U.outbox);
    const r2 = await U.send(unsPostVia(F));
    const evs = async (run) => (await (await F(`/api/facos/v1/events?run=${run}&type=decision,a2a&limit=5000`)).json()).events;
    const E1 = await evs('run-SRV1'), keys = E1.map((e) => e.key);
    check('실제 서버: 응답 유실 → 대기함 보관 → 재전송 확정', !r1.ok && held > 0 && r2.ok && U.outbox.length === 0, `보관 ${held} · ${JSON.stringify(K)}`);
    check('실제 서버: 재전송해도 FacOS 저장소에 결정 · A2A 한 번씩 (중복 0) · 서버가 중복 수를 응답', keys.every(Boolean) && dup(keys) === 0 && E1.filter((e) => e.type === 'decision').length === K.decision && E1.filter((e) => e.type === 'a2a').length === K.a2a && r2.json.duplicates === held, `기록 ${E1.length} · 응답 duplicates ${r2.json.duplicates}`);
    // JSON 오류 응답 (HTTP 400 + { error })
    makeEvents(s, ag);
    const broken = (u, o) => F(u, { ...o, body: '{깨진 JSON' }), r3 = await U.send(unsPostVia(broken)), held3 = U.outbox.length;
    const r4 = await U.send(unsPostVia(F)), E2 = await evs('run-SRV1');
    check('실제 서버: JSON 오류 응답(HTTP 400)은 실패로 — 사건 보관 → 다음 주기에 전송 · 중복 0', !r3.ok && held3 > 0 && r4.ok && U.outbox.length === 0 && dup(E2.map((e) => e.key)) === 0 && E2.length > E1.length, `${r3.error} · 보관 ${held3} · 기록 ${E1.length}→${E2.length}`);
  } catch (e) { check('실제 서버 검사 중 예외 없음', false, e.stack ?? e); }
  let kids = []; try { kids = execSync(`pgrep -P ${process.pid}`).toString().split('\n').map(Number).filter(Boolean); } catch { /* 자식 없음 */ }
  console.log(`DATASAFE_SERVER ${JSON.stringify({ out, kids })}`);
  server.close(); server.closeAllConnections?.(); await stopMqtt();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin-datasafe-'));
const { makeEpcisApi } = await import('../server/epcis-api.mjs');
const { makeFacosStore } = await import('../server/facos-store.mjs');
const mainSrc = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
// api.route를 fetch 꼴로 — 내준 범위를 모두 적어 둔다 (겹침 검사)
const grants = [];
const apiFetch = (api) => async (u, o) => {
  const r = await api.route(o?.method ?? 'GET', u.split('?')[0], new URLSearchParams(u.split('?')[1] ?? ''), o?.body ?? '');
  if (u.endsWith('/serial-reserve') && r.code === 200) for (const [k, x] of Object.entries(r.body.ranges)) grants.push({ k: k === 'pal' ? k : `${k}@${r.body.ymd}`, ...x });
  return { ok: r.code >= 200 && r.code < 300, status: r.code, json: async () => r.body };
};
const overlaps = () => { let n = 0; for (let i = 0; i < grants.length; i++) for (let j = i + 1; j < grants.length; j++) if (grants[i].k === grants[j].k && grants[i].from <= grants[j].to && grants[j].from <= grants[i].to) n++; return n; };

console.log('== R04 ① 응답 지연 — 저장소에 오늘 번호 100 · 팔레트 2 · 출하 2');
const dirE = path.join(tmp, 'epcis');
let api = makeEpcisApi({ dir: dirE, interval: 1e9 });
const s0 = newSim(3), H0 = s0.serials, ymd = H0.ymd; H0.feedOn = true;
{ for (let i = 1; i <= 100; i++) H0.toFG(H0.issue(unit(H0, i), PACK));
  for (const t of [{ id: '화물트럭-1' }, { id: '화물트럭-2' }]) H0.ship(H0.take('doortrim', 3, 'FL-1'), t);
  await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify(epcisDocument(H0.drain().map((e) => epcisEvent(H0, e, iso)).filter(Boolean), iso(0))));
  const b = (await api.route('GET', '/api/epcis/v1/serial-base', new URLSearchParams({ ymd }), '')).body;
  check('준비: 저장소 기준 번호', b.base.DT === 100 && b.pal === 2 && b.ship === 2, JSON.stringify(b));
}
const attach = (seed, fetchImpl, opt) => { const s = newSim(seed), H = s.serials; H.ymd = ymd; H.feedOn = true; H.useAllocator(H.serverAllocator(fetchImpl, opt)); return H; };
{ let release; const gate = new Promise((r) => { release = r; });
  const H = attach(11, async (u, o) => { await gate; return apiFetch(api)(u, o); }), u = unit(H, 1);
  H.issue(u, PACK); H.toFG(u); H.update();
  const st = H.allocState();
  check('응답 전: 시리얼을 발행하지 않고 보류 (DT-…-000001을 내지 않음) · 상태 표시', u.serial === null && H.waitIssue.length === 1 && H.stats.issued === 0 && st.state === 'wait' && /받는 중/.test(st.text) && st.wait === 1, `${u.serial} · ${st.text}`);
  check('응답 전: 보류된 제품은 출하 대상이 아님 · 팔레트 SSCC도 만들지 않음', H.shippable('doortrim') === 0 && H.take('doortrim', 1, 'FL-1') === null && H.pallets.length === 0);
  release(); await wait(20); H.update();
  check('응답 뒤: 저장소 마지막 번호(100) 다음부터 이어서 발행 · 적재 기록도 그때', u.serial === `DT-${ymd}-000101` && H.waitIssue.length === 0 && H.events.some((e) => e.type === 'commission' && e.id === u.serial) && H.events.some((e) => e.type === 'store' && e.id === u.serial) && H.allocState().ok, u.serial);
  const lot = H.take('doortrim', 1, 'FL-1'); H.ship(lot, { id: '화물트럭-9' });
  check('팔레트 SSCC · 출하 ID도 저장소 마지막 번호 다음부터', Number(lot.pal.sscc.slice(8, 17)) === 3 && lot.pal.shipment === `SHP-${ymd}-00003`, `${lot.pal.sscc} · ${lot.pal.shipment}`);
}

console.log('== R04 ② 요청 실패 — 조용히 1번부터 발행하지 않고 다시 시도');
{ let clock = 1e6, mode = 'http500', calls = 0;
  const flaky = async (u, o) => { calls++; if (mode === 'http500') return { ok: false, status: 500, json: async () => ({ error: '저장소 내부 오류', ranges: { 'ser:DT': { from: 1, to: 40 } } }) }; if (mode === 'net') throw new Error('fetch failed'); if (mode === 'shape') return { ok: true, status: 200, json: async () => ({ ranges: { 'ser:DT': { from: 1 } } }) }; return apiFetch(api)(u, o); };
  const H = attach(12, flaky, { now: () => clock }), A = H.alloc, u = unit(H, 1);
  H.issue(u, PACK); await wait(5);
  const s1 = H.allocState(), c1 = calls;
  check('HTTP 500 + JSON 본문(r.ok=false): 실패로 처리 — 본문의 범위를 쓰지 않음 · 발행 보류 · 사유 표시', u.serial === null && A.fails === 1 && s1.state === 'retry' && /저장소 내부 오류/.test(s1.text) && /발행 보류/.test(s1.text) && A.left('ser', 'DT') === 0, s1.text);
  H.update(); await wait(5);
  check('다시 시도 간격 전에는 요청하지 않음', calls === c1);
  mode = 'net'; clock += 600; H.update(); await wait(5);
  check('연결 실패: 간격을 늘려 다시 — 여전히 보류', calls === c1 + 1 && A.fails === 2 && u.serial === null, `실패 ${A.fails}회`);
  mode = 'shape'; clock += 5000; H.update(); await wait(5);
  check('형식이 틀린 응답(범위 없음)도 실패 — 보류', A.fails === 3 && u.serial === null && /형식 오류/.test(A.lastError), A.lastError);
  mode = 'ok'; clock += 20000; H.update(); await wait(20); H.update();
  check('서버가 돌아오면 자동으로 받아 발행 — 번호는 앞 화면이 받아 간 범위 뒤', !!u.serial && Number(u.serial.slice(-6)) > 101 && A.fails === 0 && H.allocState().ok, u.serial);
}

console.log('== R04 ③ 서버 재시작 — 예약만 하고 이벤트를 못 올린 번호도 다시 내주지 않음');
{ const before = grants.filter((g) => g.k === `ser:DT@${ymd}`).map((g) => g.to), top = Math.max(...before);
  api.close(); await wait(50); api = makeEpcisApi({ dir: dirE, interval: 1e9 });
  const H = attach(13, apiFetch(api)), u = unit(H, 1);
  H.issue(u, PACK); await wait(20); H.update();
  check('다시 켠 서버: 저장소 이벤트(100)가 아니라 마지막 예약 번호 뒤부터', Number(u.serial?.slice(-6)) === top + 1, `${u.serial} · 재시작 전 마지막 예약 ${top}`);
  const f = path.join(dirE, 'serial-alloc.json'), keep = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '{깨짐');
  const r = await api.route('POST', '/api/epcis/v1/serial-reserve', new URLSearchParams(), JSON.stringify({ ymd, need: { 'ser:DT': 5 } }));
  check('예약 기록 파일이 깨졌으면 범위를 주지 않음 (오류 응답)', r.code >= 400 && !!r.body.error, `${r.code} ${r.body.error}`);
  fs.writeFileSync(f, keep);
  const bad = await api.route('POST', '/api/epcis/v1/serial-reserve', new URLSearchParams(), JSON.stringify({ ymd, need: { 'ser:../x': 5 } }));
  check('형식이 틀린 예약 요청 거부', bad.code === 400);
}

console.log('== R04 ④ 화면 여럿 · 앱 서버 둘 동시 실행 — 번호 중복 0');
{ // 화면 둘이 같은 서버에서 공장을 1시간씩 돌린다 (요청은 비동기 — 20걸음마다 양보)
  const mk = (seed, mode) => { const s = newSim(seed, mode), H = s.serials; H.ymd = ymd; H.feedOn = true; H.useAllocator(H.serverAllocator(apiFetch(api))); return { s, H, ag: new FactoryAgent(s) }; };
  const X = mk(21, 'dark'), Y = mk(22, 'smart');
  for (let k = 0; k < 36000; k++) { for (const c of [X, Y]) { c.s.step(0.1); c.ag.update(0.1); } if (k % 20 === 0) await wait(0); }
  const all = [X, Y].flatMap((c) => c.H.units), ser = all.map((u) => u.serial).filter(Boolean), pals = [X, Y].flatMap((c) => c.H.pallets), sscc = pals.map((p) => p.sscc), ships = [...new Set(X.H.pallets.map((p) => p.shipment).filter(Boolean)), ...new Set(Y.H.pallets.map((p) => p.shipment).filter(Boolean))];
  check('화면 둘 1시간: 시리얼 발행 · 출하가 실제로 일어남', X.H.stats.issued > 20 && Y.H.stats.issued > 20 && X.H.stats.shipped > 0 && Y.H.stats.shipped > 0, `발행 ${X.H.stats.issued}/${Y.H.stats.issued} · 출하 ${X.H.stats.shipped}/${Y.H.stats.shipped} · 보류했다 발행 ${X.H.stats.deferred}/${Y.H.stats.deferred}`);
  check('시리얼 중복 0 · 모두 저장소 마지막 번호(100) 뒤', dup(ser) === 0 && ser.filter((x) => x.startsWith('DT-')).every((x) => Number(x.slice(-6)) > 100), `${ser.length}개 · 중복 ${dup(ser)}`);
  check('팔레트 SSCC 중복 0 · 출하 ID 중복 0 · 기존 번호(2) 뒤', dup(sscc) === 0 && dup(ships) === 0 && sscc.every((x) => Number(x.slice(8, 17)) > 2) && ships.every((x) => Number(x.slice(-5)) > 2), `SSCC ${sscc.length} · 출하 ${ships.length}`);
  check('시리얼 없이 출하된 제품 0 (팔레트 구성품이 모두 시리얼)', pals.every((p) => p.units.every((id) => !id.startsWith('WIP-'))) && all.filter((u) => u.loc === 'shipped').every((u) => u.serial));
  // 두 화면의 이벤트를 저장소에 올리면 발행(commissioning) EPC가 모두 다르다
  for (const c of [X, Y]) await api.route('POST', '/api/epcis/v1/capture', new URLSearchParams(), JSON.stringify(epcisDocument(c.H.drain().map((e) => epcisEvent(c.H, e, iso)).filter(Boolean), iso(0))));
  const epcs = api.store.events.filter((e) => e.bizStep === 'commissioning').flatMap((e) => e.epcList);
  check('저장소: 발행 이벤트의 EPC 중복 0', dup(epcs) === 0, `${epcs.length}건`);
  // 같은 데이터 폴더를 쓰는 앱 서버 둘(맥 앱 두 개)에 동시에 예약 요청
  const api2 = makeEpcisApi({ dir: dirE, interval: 1e9 }), n0 = grants.length;
  await Promise.all(Array.from({ length: 40 }, (_, i) => apiFetch(i % 2 ? api : api2)('/api/epcis/v1/serial-reserve', { method: 'POST', body: JSON.stringify({ ymd, need: { 'ser:DT': 7, 'ser:EA': 3, pal: 2, ship: 1 } }) })));
  check('앱 서버 둘에 동시 예약 40건 — 모두 성공 · 범위 겹침 0 (지금까지 내준 모든 범위)', grants.length - n0 === 160 && overlaps() === 0, `범위 ${grants.length}개 · 겹침 ${overlaps()}`);
  api2.close();
}

console.log('== R04 ⑤ 범위 소진 — 보류했다가 이어서 발행');
{ const H = attach(14, apiFetch(api), { sizes: { ser: 4, pal: 2, ship: 2 } }), us = [];
  await wait(20);   // 첫 범위(4개) 도착
  for (let i = 1; i <= 30; i++) { const u = unit(H, i); H.issue(u, PACK); us.push(u); }   // 응답을 기다릴 틈 없이 30개
  const now = us.filter((u) => u.serial).length;
  check('받은 범위(4개)까지만 발행 · 나머지는 보류', now === 4 && H.waitIssue.length === 26, `발행 ${now} · 보류 ${H.waitIssue.length}`);
  for (let k = 0; k < 300 && H.waitIssue.length; k++) { await wait(2); H.update(); }
  const n = us.map((u) => Number(u.serial?.slice(-6)));
  check('다음 범위를 받아 합격 순서대로 모두 발행 · 중복 0 · 번호 오름차순', us.every((u) => u.serial) && dup(n) === 0 && n.every((x, i) => !i || x > n[i - 1]), `${n[0]}…${n.at(-1)}`);
  check('모자랐던 종류는 다음 범위를 크게 받음 · 지금까지 내준 범위 겹침 0', H.alloc.pool('ser:DT').size > 4 && H.alloc.stats.blocked > 0 && overlaps() === 0, `범위 크기 ${H.alloc.pool('ser:DT').size}`);
  const A = new SerialAllocator(async () => ({ ranges: { 'ser:DT': { from: 1, to: 4 }, ship: { from: 1, to: 2 }, pal: { from: 1, to: 2 } } }), { sizes: { ser: 4, pal: 2, ship: 2 } });
  A.setYmd('261117'); A.prime(['ser:DT', 'pal', 'ship']); await wait(5); A.setYmd('261118');
  check('날짜가 바뀌면 지난 날짜의 시리얼 · 출하 범위는 버림 (팔레트 SSCC는 유지)', A.left('ser', 'DT') === 0 && A.left('ship') === 0 && A.left('pal') === 2 && A.stats.discarded === 6);
}

console.log('== R04 화면 연결부 (js/main.js epcisAttach) · 웹 버전 · 헤드리스');
{ const body = mainSrc.match(/function epcisAttach\(\) \{[\s\S]*?\n\}/)[0];
  const wire = (hub, fetchImpl) => { const s = newSim(15), SEQ = {}; s.serials.ymd = ymd; new Function('sim', 'hub', 'fetch', 'SERIAL_SEQ', 'WIP_SEQ', 'SHIP_CTR', `${body}; epcisAttach(); epcisAttach();`)(s, hub, fetchImpl, SEQ, {}, { pal: 0, ship: 0 }); return { H: s.serials, SEQ }; };
  let reply; const hub = { noServer: false }, { H } = wire(hub, () => new Promise((r) => { reply = r; })), u = unit(H, 1);
  H.issue(u, PACK);
  check('앱: 서버 응답 전에는 발행하지 않음 (검수 재현 — 전에는 DT-…-000001 발행)', u.serial === null && !!H.alloc && hub.serialAlloc === H.alloc, String(u.serial));
  reply({ ok: true, status: 200, json: async () => ({ ranges: { 'ser:DT': { from: 101, to: 140 }, 'ser:EA': { from: 1, to: 40 }, pal: { from: 101, to: 110 }, ship: { from: 101, to: 106 } } }) }); await wait(5); H.update();
  check('앱: 응답 뒤 서버가 준 범위에서 발행', u.serial === `DT-${ymd}-000101`, u.serial);
  const W = wire({ noServer: true }, () => { throw new Error('웹 버전은 서버를 부르지 않는다'); }), w = unit(W.H, 1);
  W.H.issue(w, PACK);
  check('웹 버전(서버 없음): 지금처럼 이 화면의 카운터로 바로 발행', w.serial === `DT-${ymd}-000001` && W.H.alloc === null && W.H.serSeq === W.SEQ);
  const P = newSim(16).serials, p = unit(P, 1); P.issue(p, PACK);
  check('헤드리스(new Simulation만): 서버 없이 지금처럼', P.alloc === null && /-000001$/.test(p.serial));
  check('데이터 연동 창 EPCIS 칸 · 품질 추적 창에 번호 배정 상태 표시', /식별 번호 배정/.test(mainSrc) && /allocState/.test(fs.readFileSync(new URL('../js/traceview.js', import.meta.url), 'utf8')));
}
api.close();

// ── R05 ─────────────────
const G = await import('../server/mqtt-gateway.mjs');
const dirF = path.join(tmp, 'facos'); let S = makeFacosStore({ dir: dirF });
await G.startMqtt({ host: '127.0.0.1', port: await freePort(), aclFile: path.join(tmp, 'acl.json'), sparkplug: false, engine: 'aedes' }); G.setUnsTap((...a) => S.tap(...a));
const facos = (run, type) => S.route('GET', '/api/facos/v1/events', new URLSearchParams({ run, type, limit: '5000' })).body.events;
const serverPost = async (messages) => { const d0 = G.mqttDedup.duplicates, published = G.mqttPublish(messages), status = G.mqttStatus(); return { published, duplicates: G.mqttDedup.duplicates - d0, accepted: !!status.listening, status, facos: S.status() }; };
const s = newSim(31), ag = new FactoryAgent(s); run(s, ag, 60);
let runName = 'run-A';
const U = new UnsNamespace(s, { run: () => runName, iso });

console.log('== R05 ⑥ 전송 실패 → 다시 보내는 묶음에 결정 · A2A · 명령 · 현장 업링크가 그대로');
{ await U.send(serverPost);   // 첫 탄생 · 그동안 쌓인 사건
  const base = { decision: facos('run-A', 'decision').length, a2a: facos('run-A', 'a2a').length };
  makeEvents(s, ag);
  let sent1 = null; const r1 = await U.send(async (m) => { sent1 = m; throw new Error('fetch failed'); });
  const held = U.outbox.map((m) => ({ ...m })), K1 = kinds(held);
  check('실패한 묶음의 사건이 대기함에 남음 — 결정 · A2A · 명령 · 현장 업링크 모두', !r1.ok && K1.decision >= 1 && K1.a2a >= 1 && K1.cmd >= 1 && K1.field >= 1 && held.every((m) => m.key && m.run === 'run-A'), JSON.stringify(K1));
  check('전송 실패가 화면 상태에 남음 (사유 · 실패 횟수)', U.tx.failed === 1 && U.tx.lastError === 'fetch failed' && U.broker.error === 'fetch failed');
  let sent2 = null; const r2 = await U.send(async (m) => { sent2 = m; return serverPost(m); });
  const again = sent2.filter((m) => m.key), same = held.every((h) => again.some((m) => m.key === h.key && m.topic === h.topic && m.payload === h.payload));
  check('다시 보낸 묶음에 같은 사건이 그대로 (검수 재현 — 전에는 결정 0 · A2A 0)', r2.ok && same && kinds(again).decision >= K1.decision && kinds(again).a2a >= K1.a2a && kinds(again).cmd >= K1.cmd && kinds(again).field >= K1.field, `재전송 ${JSON.stringify(kinds(again))}`);
  check('실패한 주기의 상태는 rebirth로 다시 (탄생 메시지부터)', sent2.some((m) => m.topic === `${UNS_ROOT}/_meta/namespace`) && sent2.filter((m) => m.retain).length >= sent1.filter((m) => m.retain).length);
  const D = facos('run-A', 'decision'), A = facos('run-A', 'a2a');
  check('성공 뒤: 대기함 비움 · FacOS 저장소에 한 번씩 (유실 0 · 중복 0)', U.outbox.length === 0 && D.length === base.decision + K1.decision && A.length === base.a2a + K1.a2a && dup([...D, ...A].map((e) => e.key)) === 0, `결정 ${base.decision}→${D.length} · A2A ${base.a2a}→${A.length}`);
}

console.log('== R05 ⑦ 응답만 유실 (서버는 받음) → 다시 보내도 한 번만');
{ makeEvents(s, ag);
  const d0 = facos('run-A', 'decision').length, a0 = facos('run-A', 'a2a').length, dd0 = G.mqttDedup.duplicates;
  const r1 = await U.send(async (m) => { await serverPost(m); throw new Error('응답 유실'); }), n = U.outbox.length, K = kinds(U.outbox);
  const r2 = await U.send(serverPost);
  check('응답 유실 → 대기함에 남았다가 재전송 · 서버가 key로 걸러 발행 · 기록 모두 한 번', !r1.ok && n > 0 && r2.ok && U.outbox.length === 0 && r2.json.duplicates === n && G.mqttDedup.duplicates - dd0 === n && facos('run-A', 'decision').length === d0 + K.decision && facos('run-A', 'a2a').length === a0 + K.a2a, `재전송 ${n}건 · 서버 중복 처리 ${r2.json.duplicates}건`);
  // 앱 서버가 다시 켜진 뒤(게이트웨이 기억 없음)에 같은 key가 와도 FacOS 파일 기준으로 거른다
  const one = facos('run-A', 'decision').at(-1), cnt = facos('run-A', 'decision').length;
  S = makeFacosStore({ dir: dirF }); S.tap(`${UNS_ROOT}/_meta/namespace`, JSON.stringify({ run: 'run-A' }));
  S.tap(one.topic, JSON.stringify(one.data), { key: one.key, run: 'run-A' });
  check('앱 서버를 다시 켠 뒤 같은 key — FacOS 저장소가 파일에서 걸러 다시 쓰지 않음', facos('run-A', 'decision').length === cnt && S.status().duplicates === 1);
  const S3 = makeFacosStore({ dir: dirF }); S3.tap(`${UNS_ROOT}/_facos/decision/late`, JSON.stringify({ kind: 'late' }), { key: 'run-Z:x:late1', run: 'run-Z' });
  check('앱 서버를 다시 켠 직후(탄생 메시지 전)에 온 사건도 그 실행 파일에 기록', facos('run-Z', 'decision').some((e) => e.key === 'run-Z:x:late1') && facos('run-Z', 'run').length === 1);
}

console.log('== R05 ⑧ r.ok=false · JSON 오류 응답 · 브로커 꺼짐 = 실패');
{ makeEvents(s, ag);
  const res = (ok, status, body) => async () => ({ ok, status, json: async () => body });
  const r1 = await U.send(unsPostVia(res(false, 500, { error: '게이트웨이 내부 오류', published: 99, status: { listening: true } }))), n1 = U.outbox.length;
  check('HTTP 500 + JSON 본문: 실패 — 사건을 확정하지 않음 · 사유 기록', !r1.ok && n1 > 0 && /게이트웨이 내부 오류/.test(U.tx.lastError), U.tx.lastError);
  const r2 = await U.send(unsPostVia(res(false, 503, null)));
  const r3 = await U.send(unsPostVia(res(true, 200, { error: 'JSON 오류 응답' })));
  const r4 = await U.send(unsPostVia(res(true, 200, { published: 0, accepted: false, status: { listening: false, error: 'EADDRINUSE' } })));
  check('JSON 없는 503 · 200인데 { error } · 브로커 꺼짐(accepted:false) 모두 실패 — 대기함 그대로', !r2.ok && !r3.ok && !r4.ok && U.outbox.length >= n1 && /HTTP 503/.test(r2.error) && /꺼져/.test(r4.error), `${r2.error} | ${r3.error} | ${r4.error}`);
  const r5 = await U.send(serverPost);
  check('그 뒤 성공하면 한 번에 확정', r5.ok && U.outbox.length === 0 && dup(facos('run-A', 'decision').map((e) => e.key).filter(Boolean)) === 0);
}

console.log('== R05 ⑨ 상태 rebirth와 사건 재전송 분리');
{ const acked = U.tx.acked; U.rebirth(); let sent = null;
  await U.send(async (m) => { sent = m; return serverPost(m); });
  check('rebirth: retain 상태만 다시 — 이미 확정한 사건은 다시 보내지 않음', sent[0].topic === `${UNS_ROOT}/_meta/namespace` && sent.filter((m) => m.retain).length > 3 && sent.filter((m) => m.key).length === 0 && U.tx.acked === acked, `상태 ${sent.length}건 · 사건 ${sent.filter((m) => m.key).length}건`);
  const out = new UnsNamespace(newSim(32)).collect();
  check('헤드리스 collect()는 지금처럼 (대기함에 넣지 않음) · 주기 데이터에는 key 없음', out.length > 0 && out.filter((m) => m.topic.endsWith('/telemetry') || m.topic.endsWith('/kpi')).every((m) => !m.key));
}

console.log('== R05 ⑩ 단계 전환 · 리셋 중 보존 — 이전 실행 ID로');
{ makeEvents(s, ag);   // 아직 거두지 않은 이전 실행(run-A)의 사건
  const failing = async () => { throw new Error('fetch failed'); };
  await U.send(failing); makeEvents(s, ag);   // 실패로 대기 중인 것 + 전환 직전 2초분
  const dA = facos('run-A', 'decision').length;
  // js/main.js: 새 실행을 보면 이전 실행분을 거두고(harvest) 넘어간다
  const got = U.harvest(), KA = kinds(U.outbox);
  const s2 = newSim(33, 'smart'), ag2 = new FactoryAgent(s2); runName = 'run-B'; U.reset(s2); run(s2, ag2, 30); makeEvents(s2, ag2);
  check('전환 뒤에도 이전 실행의 사건이 대기함에 (실행 ID run-A 그대로)', got > 0 && KA.decision >= 2 && U.outbox.length > 0 && U.outbox.slice(0, got).every((m) => m.run === 'run-A'), `전환 직전 거둔 ${got}건 · ${JSON.stringify(KA)}`);
  await U.send(failing);   // 새 실행의 첫 주기도 실패
  let sent = null; const r = await U.send(async (m) => { sent = m; return serverPost(m); });
  const oldEv = sent.filter((m) => m.run === 'run-A'), newEv = sent.filter((m) => m.run === 'run-B');
  check('서버가 돌아오면 이전 실행 사건 + 새 실행 탄생 · 사건을 함께 전송', r.ok && oldEv.length > 0 && newEv.length > 0 && JSON.parse(sent.find((m) => m.topic === `${UNS_ROOT}/_meta/namespace`).payload).run === 'run-B' && U.outbox.length === 0, `run-A ${oldEv.length}건 · run-B ${newEv.length}건`);
  const A = facos('run-A', 'decision'), B = facos('run-B', 'decision');
  check('FacOS 저장소: 이전 실행 사건은 run-A 파일에 · 새 실행 사건은 run-B 파일에 (섞이지 않음 · 중복 0)', A.length === dA + KA.decision && B.length === kinds(newEv).decision && S.status().run === 'run-B' && dup([...A, ...B].map((e) => e.key).filter(Boolean)) === 0 && A.every((e) => !e.key || e.key.startsWith('run-A:')) && B.every((e) => e.key.startsWith('run-B:')), `run-A 결정 ${dA}→${A.length} · run-B 결정 ${B.length}`);
  const seqs = S.route('GET', '/api/facos/v1/events', new URLSearchParams({ run: 'run-A', limit: '5000' })).body.events.map((e) => e.seq);
  check('늦게 쓴 줄도 그 파일의 번호를 이어 씀', seqs.every((x, i) => !i || x === seqs[i - 1] + 1));
  check('화면 연결부(js/main.js): 대기함 전송 · 전환 전 거두기 · HTTP 오류 확인을 쓴다', /uns\.send\(unsPostVia\(/.test(mainSrc) && /uns\.harvest\(/.test(mainSrc) && !/unsSince = E\.next/.test(mainSrc) && !/const j = await r\.json\(\); uns\.broker\.on/.test(mainSrc));
}

console.log('== R05 ⑪ 대기함 한도 — 넘치면 버린 것을 기록');
{ const V = new UnsNamespace(newSim(34), { run: () => 'run-C', outboxMax: 20 }), sV = V.sim, agV = new FactoryAgent(sV); run(sV, agV, 30);
  const failing = async () => { throw new Error('fetch failed'); };
  for (let i = 0; i < 6; i++) { makeEvents(sV, agV); V.enqueue([{ topic: 'metafactory/events/v1/warn', payload: `{"n":${i}}` }], 'flat'); await V.send(failing); }
  const L = V.lost, last = V.outbox.at(-1);
  check('한도(20건)까지만 보관 · 오래된 것부터 버림', V.outbox.length === 20 && L.n > 0 && V.evSeq === L.n + 20, `보관 ${V.outbox.length} · 버림 ${L.n}`);
  check('무엇을 버렸는지 기록 — 건수 · 종류 · 실행 · key 범위 · 사유', L.log.length > 0 && L.log[0].n > 0 && Object.keys(L.kinds).length >= 2 && Object.values(L.kinds).reduce((a, b) => a + b, 0) === L.n && L.log[0].runs[0] === 'run-C' && !!L.log[0].first && !!L.log[0].last && /한도/.test(L.log[0].why), JSON.stringify(L.kinds));
  check('가장 최근 사건은 남아 있음 · 요약에 대기 · 유실 건수', last.key.endsWith(`:${V.evSeq}`) && V.summary().outbox === 20 && V.summary().lost === L.n);
  check('데이터 연동 창에 UNS 사건 전송 상태(확정 · 대기 · 실패 · 버림) 표시', /UNS 사건 전송/.test(mainSrc) && /대기함 한도 초과로 버림/.test(mainSrc));
}
await G.stopMqtt();

console.log('== R05 ⑫ 평면 토픽 (DataHub) — 일시 전송 실패 ≠ 서버 없음');
{ const realFetch = globalThis.fetch; let mode = 'down', posted = [];
  globalThis.fetch = async (u, o) => { if (mode === 'down') throw new Error('fetch failed'); if (mode === '500') return { ok: false, status: 500, json: async () => ({ error: 'x' }) }; const m = JSON.parse(o.body).messages; posted.push(...m); return { ok: true, status: 200, json: async () => ({ published: m.length, status: { listening: true, host: '127.0.0.1', port: 1883 } }) }; };
  try {
    const sH = newSim(41), agH = new FactoryAgent(sH), hub = new DataHub(); hub.reset(sH, null);
    const once0 = hub.queue.filter((m) => m.retain).length;
    sH.cmd.issue('SPEED', 'all', 75, { by: '시험', why: '평면 토픽' }); for (let t = 0; t < 30; t += 0.1) { sH.step(0.1); agH.update(0.1); hub.tick(0); }
    const cmds = hub.queue.filter((m) => /\/Commands$/.test(m.topic)).length, total = hub.queue.length;
    await hub.flush();
    check('한 번 실패: 「서버 없음」으로 굳히지 않음 (available ≠ false) · 일시 실패로 표시할 값', hub.mqtt.available !== false && hub.mqtt.fails === 1 && hub.mqtt.lastError === 'fetch failed' && hub.mqtt.retryAt > Date.now() && !hub.noServer, `fails ${hub.mqtt.fails}`);
    check('메타데이터(retain) · 명령은 보관해 재전송 · 주기 수집값만 건너뜀(건수 기록)', once0 > 0 && cmds > 0 && hub.queue.filter((m) => m.retain).length === once0 && hub.queue.filter((m) => /\/Commands$/.test(m.topic)).length === cmds && hub.mqtt.failed > 0 && hub.mqtt.failed + hub.queue.length === total, `보관 ${hub.queue.length} · 건너뜀 ${hub.mqtt.failed}`);
    const q1 = hub.queue.length; await hub.flush();
    check('다시 시도 간격 전에는 보내지 않고 기다림 (대기열 유지)', hub.queue.length === q1 && hub.mqtt.fails === 1);
    mode = '500'; hub.mqtt.retryAt = 0; await hub.flush();
    check('HTTP 500도 일시 실패 — 연속 실패 수 증가 · 간격 늘림', hub.mqtt.fails === 2 && hub.mqtt.available !== false && hub.queue.filter((m) => m.retain).length > 0);
    mode = 'ok'; hub.mqtt.retryAt = 0;
    for (let k = 0; k < 10 && hub.queue.length; k++) await hub.flush();
    check('서버가 돌아오면 자동으로 이어서 발행 — 메타데이터 · 명령이 모두 도착', hub.mqtt.available === true && hub.mqtt.fails === 0 && hub.queue.length === 0 && posted.filter((m) => m.retain).length === once0 && posted.filter((m) => /\/Commands$/.test(m.topic)).length === cmds, `보냄 ${posted.length} (retain ${posted.filter((m) => m.retain).length}/${once0} · 명령 ${cmds})`);
    globalThis.window = { JIN3D_NO_SERVER: true }; const web = new DataHub(); delete globalThis.window; web.reset(sH, null); mode = 'down'; await web.flush();
    check('웹 버전(noServer): 지금처럼 서버를 부르지 않고 대기열만 비움', web.noServer && web.mqtt.available === false && web.queue.length === 0 && web.mqtt.fails === 0);
  } finally { globalThis.fetch = realFetch; }
  check('화면 문구: 일시 전송 실패와 서버 없음을 구분 (available === false 한 가지로 「서버 없이 열려 있어」를 띄우지 않음)', /일시 전송 실패/.test(mainSrc) && !/mq\.available === false \?/.test(mainSrc) && /hub\.noServer \? '<b class="bad">웹 버전에서는 사용할 수 없음/.test(mainSrc));
}

console.log('== R05 ⑫ EPCIS 수집 (js/main.js epcisCollect · epcisPump) — 실패해도 유실 · 중복 없음');
{ const fnA = mainSrc.match(/function epcisCollect\(\) \{[\s\S]*?\n\}/)[0], fnB = mainSrc.match(/async function epcisPump\(\) \{[\s\S]*?\n\}/)[0];
  const apiE = makeEpcisApi({ dir: path.join(tmp, 'epcis2'), interval: 1e9 }), sE = newSim(51), HE = sE.serials; HE.feedOn = true;
  for (let i = 1; i <= 30; i++) HE.toFG(HE.issue(unit(HE, i), PACK));
  const st = { retry: [], sent: 0, failed: 0, lastError: null, server: null, busy: false, dropped: 0 };
  let mode = 'down'; const f = async (u, o) => { if (mode === 'down') throw new Error('fetch failed'); const r = await apiFetch(apiE)(u, o); return mode === 'lost' ? { ok: false, status: 502, json: async () => ({}) } : r; };
  const { epcisPump } = new Function('sim', 'hub', 'fetch', 'epcisEvent', 'epcisDocument', 'epcisLocal', 'epcisSt', `${fnA}; ${fnB}; return { epcisPump };`)(sE, { noServer: false, iso: (t = 0) => iso(t) }, f, epcisEvent, epcisDocument, null, st);
  await epcisPump(); const want = st.retry.length;
  check('전송 실패: 이벤트가 대기열에 그대로 · 사유 기록', want >= 60 && st.sent === 0 && st.lastError === 'fetch failed' && apiE.store.count === 0, `대기 ${st.retry.length}`);
  mode = 'lost'; await epcisPump();
  check('서버는 받았는데 응답이 HTTP 502: 확정하지 않고 대기열 유지', st.retry.length === want && apiE.store.count === want);
  mode = 'ok'; for (let i = 31; i <= 35; i++) HE.issue(unit(HE, i), PACK); await epcisPump();
  check('다시 보내면 eventID로 한 번만 저장 (유실 0 · 중복 0)', st.retry.length === 0 && apiE.store.count === want + 5 && apiE.store.stats.duplicate === want && dup(apiE.store.events.map((e) => e.eventID)) === 0, `저장 ${apiE.store.count} · 중복 제외 ${apiE.store.stats.duplicate}`);
  apiE.close();
}

console.log('== ⑬ 실제 앱 서버 (startServer — 내장 브로커 · 센서 서버 · EPCIS · FacOS 저장소)');
{ const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--server'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outText = '', errText = ''; child.stdout.on('data', (d) => { outText += d; }); child.stderr.on('data', (d) => { errText += d; });
  const code = await new Promise((r) => { const to = setTimeout(() => { child.kill('SIGKILL'); r('timeout'); }, 90000); child.on('exit', (c) => { clearTimeout(to); r(c); }); });
  const line = outText.split('\n').find((l) => l.startsWith('DATASAFE_SERVER '));
  if (!line) check('실제 앱 서버 검사 실행', false, `종료 ${code} · ${errText.slice(-400)}`);
  else {
    const R = JSON.parse(line.slice(16)); for (const c of R.out) check(c.name, c.ok, c.info);
    await wait(800);
    const alive = R.kids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    check('끝난 뒤 서버가 띄운 자식 프로세스(Mosquitto · 센서 서버)가 남지 않음', code === 0 && R.kids.length >= 1 && alive.length === 0, `자식 ${R.kids.length}개 · 남은 것 ${alive.length}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
