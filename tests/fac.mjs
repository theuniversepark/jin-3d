// FAC 검증 (FACOS 업무 기록: 발주 · 재고 · 설비보전)
// ① FAC 기록: 피지컬AI 2시간 — 구매오더 = WMS 발주, 입고 확정 = 입고 트럭, 재고(로케이션별) = 시뮬레이션 재고와 정확히 일치,
//    출고 = 출하 수량, 정비요청 = 고장(긴급)·정비 지시(예방), 완료 시 소요 시간
// ② FAC API: 같은 이벤트·현황을 server/fac-api.mjs에 올려 조회(/po · /moves · /stock · /mr · /equipment)와
//    이벤트 이력(/events?since= 이어 받기 · 유형 필터)이 FAC 기록과 같은지, 새 운전이면 기록을 비우는지
// 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { facRoute, facReset } from '../server/fac-api.mjs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
for (let t = 0; t < 2 * 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
const st = s.processing.find((x) => x.id === 'DT_ASSY'); s.injectFault(st);
for (let t = 0; t < 400; t += 0.1) { s.step(0.1); ag.update(0.1); }
const E = s.fac; E.closeWindow();
const S = E.stats(), Q = E.quant, P = E.db.picking;
// 진행 중 구매오더 = 아직 트럭에 안 실린 발주 + 트럭이 실어 왔지만 입고 확정 전(마지막 팔레트를 지게차가 옮기는 중이면 출차 후에도 확정 대기)
// 진행 중(전표 미확정) 수량: 입고 트럭에서 이미 선반에 넣었지만 아직 입고 확정 전 / 구분 적재장에서 꺼냈지만 출고 확정 전(지게차·출발 전 트럭)
const pendIn = (k) => P.filter((p) => p.type === 'incoming' && p.state !== 'done').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === k ? l.done : 0), 0);
const pendOut = (k) => P.filter((p) => p.type === 'outgoing' && p.state !== 'done').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === k ? l.done : 0), 0)
  + (s.forklifts ?? []).reduce((a, f) => a + (f.load?.type === 'fg' && (f.load.product ?? 'doortrim') === k ? f.load.n : 0), 0);
const expRaw = s.whRaw - pendIn('raw'), expParts = s.whParts - pendIn('parts'), expDT = s.fgBy.doortrim + pendOut('doortrim'), expEA = s.fgBy.eaxle + pendOut('eaxle');
console.log('== FAC 기록 (피지컬AI 2시간)');
check('구매오더 = WMS 발주 · 입고 확정 + 진행 중 = 구매오더 수', S.po > 0 && S.receipts + S.poOpen === S.po && S.receipts >= s.inbound.stats.trucks - 1 && S.poOpen === s.inbound.orders.length + [...E.byTruck.values()].filter((r) => !r.po.received).length, `구매오더 ${S.po}건 · 입고 확정 ${S.receipts} · 진행 중 ${S.poOpen} · ${(S.amount / 1e6).toFixed(1)}백만원`);
check('입고 수량 = 입고 트럭이 내린 수량 (원자재·부품)', P.filter((p) => p.type === 'incoming').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === 'raw' ? l.done : 0), 0) === s.inbound.stats.raw && P.filter((p) => p.type === 'incoming').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === 'parts' ? l.done : 0), 0) === s.inbound.stats.parts, `원자재 ${s.inbound.stats.raw} · 부품 ${s.inbound.stats.parts}`);
check('물류 선반 재고 = 시뮬레이션 창고 재고 − 입고 확정 전 수량', Q.rackRaw.raw === expRaw && Q.rackParts.parts === expParts, `원자재 ${Q.rackRaw.raw} (창고 ${s.whRaw} − 확정 전 ${pendIn('raw')}) · 부품 ${Q.rackParts.parts}`);
check('구분 적재장 재고 = 시뮬레이션 적재 + 출고 확정 전(지게차·출발 전 트럭)', Q.output.doortrim === expDT && Q.output.eaxle === expEA, `도어트림 ${Q.output.doortrim} (적재 ${s.fgBy.doortrim} + ${pendOut('doortrim')}) · e-axle ${Q.output.eaxle}`);
check('출고 확정 수량 = 출하 트럭 상차 수량', Q.customer.doortrim + Q.customer.eaxle === s.stats.shipped - P.filter((p) => p.type === 'outgoing' && p.state !== 'done').flatMap((p) => p.lines).reduce((a, l) => a + l.done, 0), `출고 ${S.deliveries}건 · ${Q.customer.doortrim + Q.customer.eaxle}개`);
check('재고 보존: 모든 로케이션 원자재·부품 합 = 기초 + 확정 입고', Object.values(Q).reduce((a, q) => a + q.raw + q.parts, 0) === 200 + 1200 + s.inbound.stats.raw + s.inbound.stats.parts - pendIn('raw') - pendIn('parts'));
check('내부 이동(AGV·휴머노이드 출고)·생산 입고가 10분 단위 전표', S.internals > 5 && S.productions > 5, `내부 이동 ${S.internals} · 생산 입고 ${S.productions}`);
const corr = E.db.mr.filter((m) => m.type === 'corrective'), prev = E.db.mr.filter((m) => m.type === 'preventive');
check('설비 고장 → 긴급 정비요청 · 수리 후 완료(소요 시간)', corr.some((m) => m.equipment === (st.uid ?? st.id) && m.stage === 'done' && m.duration > 0), `긴급 ${corr.length}건`);
check('정비 지시 → 예방 정비요청 (예지정비 횟수와 맞음)', prev.length >= s.stats.pm && prev.length > 0, `예방 ${prev.length}건 · 예지정비 완료 ${s.stats.pm}회`);
check('설비 등록: 셀·셀 로봇·이동 로봇·드론 (일련번호 = 설비 고유 ID)', S.equipment > 40 && E.db.equipment.every((e) => e.serial_no), `${S.equipment}대`);
check('전표 번호 형식 (P / WH/IN / WH/INT / WH/MO / WH/OUT / MR)', /^P\d{5}$/.test(E.db.po[0].name) && P.some((p) => /^WH\/IN\/\d{5}$/.test(p.name)) && P.some((p) => /^WH\/OUT\/\d{5}$/.test(p.name)) && /^MR\/\d{5}$/.test(E.db.mr[0].ref));
{ const t = new Simulation('traditional', 2, { line: zoneLine(), quiet: true }); check('레거시 단계: FAC 기록 없음 (수기 발주)', !t.fac.on && t.fac.outbox.length === 0 && !t.fac.master); }

console.log('== FAC API (조회 · 이벤트)');
const get = (path, q = '') => facRoute('GET', path, new URLSearchParams(q), '');
const push = (body) => facRoute('POST', '/api/fac/push', new URLSearchParams(), JSON.stringify(body));
facReset();
check('기록 전: 상태 비활성 · 조회는 503', get('/api/fac/status').body.active === false && get('/api/fac/po').code === 503);
const evs = E.pending(), half = Math.floor(evs.length / 2), snap = JSON.parse(JSON.stringify(E.snapshot()));
const r1 = push({ run: E.run, events: evs.slice(0, half), snapshot: snap }), r2 = push({ run: E.run, events: [E.master, ...evs.slice(half)], snapshot: snap });
const stt = get('/api/fac/status').body;
check('업로드 두 번 → 이벤트 모두 보관 (마스터 중복 무시)', r1.code === 200 && r2.code === 200 && r2.body.accepted === evs.length - half && stt.active && stt.run === E.run && stt.events === evs.length && stt.seq === evs.length, `이벤트 ${stt.events}건 · 현황 ${(JSON.stringify(snap).length / 1024).toFixed(0)}KB`);
const po = get('/api/fac/po').body.data, mv = get('/api/fac/moves').body.data, stock = get('/api/fac/stock').body.data.stock, mr = get('/api/fac/mr').body.data, eq = get('/api/fac/equipment').body.data;
check('① 조회: 구매오더 · 재고 전표 = FAC 기록', po.length === Math.min(500, S.po) && po[0].name === E.db.po[0].name && mv.length === Math.min(500, P.length) && mv[0].name === P[0].name, `구매오더 ${po.length} · 전표 ${mv.length}`);
check('① 조회: 로케이션별 현재고 = FAC 재고', stock.rackRaw.raw === Q.rackRaw.raw && stock.rackParts.parts === Q.rackParts.parts && stock.output.doortrim === Q.output.doortrim && stock.customer.eaxle === Q.customer.eaxle);
check('① 조회: 정비요청 · 설비 대장 · 재주문 규칙', mr.length === E.db.mr.length && mr.some((m) => m.type === 'corrective' && m.stage === 'done') && eq.length === S.equipment && get('/api/fac/orderpoints').body.data.length === 2);
const all = get('/api/fac/events', 'since=0&limit=5000').body.events;
check('② 이벤트: 마스터가 seq 1 · 순서대로 빠짐없이', all.length === evs.length && all[0].type === 'master' && all.every((e, i) => e.seq === i + 1) && all.at(-1).key === evs.at(-1).key);
{ let since = 0, got = 0, pages = 0;
  for (;;) { const r = get('/api/fac/events', `since=${since}&limit=50`).body; if (!r.events.length) break; if (r.events[0].seq !== since + 1) break; got += r.events.length; since = r.next; pages++; }
  check('② 이벤트: next로 이어 받기 (50건씩)', got === evs.length, `${pages}쪽 · ${got}건`); }
{ const r = get('/api/fac/events', 'since=0&limit=5000&type=mr.create,mr.stage').body.events;
  check('② 이벤트: 유형 필터 (정비요청 생성·단계)', r.length > 0 && r.every((e) => e.type === 'mr.create' || e.type === 'mr.stage') && r.filter((e) => e.type === 'mr.create').length === E.db.mr.length); }
check('읽기 전용: 조회에 POST · 업로드에 GET은 405, 모르는 경로는 처리 안 함', facRoute('POST', '/api/fac/po', new URLSearchParams(), '{}').code === 405 && get('/api/fac/push').code === 405 && get('/api/fac/nothing') === null && push({ events: [] }).code === 400);
push({ run: 'next-run', events: [{ type: 'master', t: 0 }], snapshot: snap });
check('새 운전 ID → 기록을 비우고 seq 1부터', get('/api/fac/status').body.run === 'next-run' && get('/api/fac/events', 'since=0').body.events.length === 1);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
