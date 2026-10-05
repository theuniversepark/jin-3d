// Odoo 연동 검증 (1순위: 발주 · 재고 · 설비보전)
// ① 시뮬레이션 Odoo: 피지컬AI 2시간 — 구매오더 = WMS 발주, 입고 확정 = 입고 트럭, 재고(로케이션별) = 시뮬레이션 재고와 정확히 일치,
//    출고 = 출하 수량, 정비요청 = 고장(긴급)·정비 지시(예방), 완료 시 소요 시간
// ② 실시간 Odoo: 같은 이벤트를 게이트웨이(server/odoo-gateway.mjs)로 가짜 Odoo(JSON-RPC, tests/fake-odoo.mjs)에 보내
//    Odoo 쪽 재고·구매오더·정비요청이 시뮬레이션과 같은지 (Odoo 17 · 18 제품 유형)
// 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { ODOO_LOCS } from '../js/odoo.js';
import { startFakeOdoo } from './fake-odoo.mjs';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
for (let t = 0; t < 2 * 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
const st = s.processing.find((x) => x.id === 'DT_ASSY'); s.injectFault(st);
for (let t = 0; t < 400; t += 0.1) { s.step(0.1); ag.update(0.1); }
const E = s.erp; E.closeWindow();
const S = E.stats(), Q = E.quant, P = E.db.picking;
// 진행 중 구매오더 = 아직 트럭에 안 실린 발주 + 트럭이 실어 왔지만 입고 확정 전(마지막 팔레트를 지게차가 옮기는 중이면 출차 후에도 확정 대기)
// 진행 중(전표 미확정) 수량: 입고 트럭에서 이미 선반에 넣었지만 아직 입고 확정 전 / 구분 적재장에서 꺼냈지만 출고 확정 전(지게차·출발 전 트럭)
const pendIn = (k) => P.filter((p) => p.type === 'incoming' && p.state !== 'done').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === k ? l.done : 0), 0);
const pendOut = (k) => P.filter((p) => p.type === 'outgoing' && p.state !== 'done').flatMap((p) => p.lines).reduce((a, l) => a + (l.product === k ? l.done : 0), 0)
  + (s.forklifts ?? []).reduce((a, f) => a + (f.load?.type === 'fg' && (f.load.product ?? 'doortrim') === k ? f.load.n : 0), 0);
const expRaw = s.whRaw - pendIn('raw'), expParts = s.whParts - pendIn('parts'), expDT = s.fgBy.doortrim + pendOut('doortrim'), expEA = s.fgBy.eaxle + pendOut('eaxle');
console.log('== 시뮬레이션 Odoo (피지컬AI 2시간)');
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
{ const t = new Simulation('traditional', 2, { line: zoneLine(), quiet: true }); check('레거시 단계: ERP 연동 없음 (수기 발주)', !t.erp.on && t.erp.outbox.length === 0 && !t.erp.master); }

console.log('== 실시간 Odoo (게이트웨이 → JSON-RPC, 가짜 Odoo)');
for (const version of ['17.0', '18.0']) {
  const fake = await startFakeOdoo({ version });
  const G = await import(`../server/odoo-gateway.mjs?v=${version}`);
  G.odooConfig({ url: fake.url, db: 'jin3d', user: 'admin', key: 'test-key' });
  let res, err = null;
  try { res = await G.odooSync(E.pending()); } catch (e) { err = e.message; }
  const st2 = G.odooStatus();
  check(`Odoo ${version}: 로그인 · 이벤트 ${E.pending().length}건 모두 적용 (실패 0)`, !err && res.applied === E.pending().length && st2.failed === 0, err ?? st2.lastError ?? `구매오더 ${st2.created['purchase.order'] ?? 0} · 전표 ${st2.created['stock.picking'] ?? 0} · 정비요청 ${st2.created['maintenance.request'] ?? 0}`);
  const raw = fake.stockAt('물류선반-원자재', 'RM-BOX'), parts = fake.stockAt('물류선반-부품', 'PT-KIT'), dt = fake.stockAt('구분적재장', 'FG-DT'), ea = fake.stockAt('구분적재장', 'FG-EA');
  check(`Odoo ${version}: Odoo 재고 = 시뮬레이션 Odoo 재고 (선반 원자재·부품, 구분 적재장)`, raw === Q.rackRaw.raw && parts === Q.rackParts.parts && dt === Q.output.doortrim && ea === Q.output.eaxle, `원자재 ${raw} · 부품 ${parts} · 도어트림 ${dt} · e-axle ${ea}`);
  const pos = [...fake.T['purchase.order'].values()], mrs = [...(fake.T['maintenance.request']?.values() ?? [])];
  check(`Odoo ${version}: 구매오더 확정 · 정비요청 단계(완료) · 재주문 규칙 · 설비`, pos.length === S.po && pos.every((p) => p.state === 'purchase') && mrs.length === E.db.mr.length && mrs.filter((m) => m.stage_id?.[0] && fake.T['maintenance.stage'].get(m.stage_id[0]).done).length === E.db.mr.filter((m) => m.stage === 'done').length && fake.T['stock.warehouse.orderpoint'].size === 2 && fake.T['maintenance.equipment'].size === S.equipment);
  fake.close();
}
void ODOO_LOCS;
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
