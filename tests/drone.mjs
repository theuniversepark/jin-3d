// 드론 우선 출동 검증 — 설비 고장·현장 이벤트가 나면 드론이 정비·대응 자원보다 먼저 현장에 도착해 중계하고,
// 관찰 정보가 오케스트레이터 판단 보강·대응 조치에 반영되는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const s = new Simulation('dark', 1, { line: zoneLine(), quiet: true }); const ag = new FactoryAgent(s);
const run = (sec, until) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); if (until?.()) return; } };
run(120);
const D = () => s.drones.find((x) => x.mission) ?? s.drones[0];
check('드론 운용 대수 3대 (산정값)', s.drones.length === 3, `${s.drones.length}대`);
console.log('== 설비 고장');
const st = s.processing.find((x) => x.id === 'EA_FAST');
s.fail(st); const inc = s.orch.find(`fail:${st.id}`); const rep0 = st.repairRemaining;
run(0.3); const d = s.drones.find((x) => x.mission === inc);
check('고장 즉시 가장 가까운 가용 드론 우선 출동 (순찰 중단)', !!d && d.mode === 'mission' && inc.steps.some((x) => x.text.includes('우선 출동')), d?.id);
let techAt = null; run(200, () => { if (st.techOnSite && techAt == null) techAt = s.time - inc.t0; return inc.status !== 'open'; });
check('드론이 정비 로봇보다 먼저 현장 도착', inc.drone && techAt != null && inc.drone.dt < techAt, `드론 ${inc.drone?.dt.toFixed(1)}초 · 정비 ${techAt?.toFixed(1)}초`);
check('도착 보고: 현장 중계·관찰 정보 기록', inc.steps.some((x) => x.lane === 'field' && x.text.includes('현장 도착') && x.text.includes('중계')) && !!inc.drone.obs);
check('관찰 정보로 판단 보강 (수리 계획 반영)', inc.steps.some((x) => x.lane === 'orch' && x.text.startsWith('판단 보강')) && st.repairTotal < rep0 + 1e-9, `예상 수리 ${rep0.toFixed(0)}초 → ${(rep0 * 0.85).toFixed(0)}초`);
run(1); check('인시던트 종료 후 순찰 복귀', d.mode === 'patrol' && !d.mission);
console.log('== 여러 대 운용');
{ const a = s.processing.find((x) => x.id === 'SORT'), b = s.processing.find((x) => x.id === 'PACK'); s.fail(a); s.fail(b); run(0.5);
  const ia = s.orch.find(`fail:${a.id}`), ib = s.orch.find(`fail:${b.id}`), da = s.drones.find((x) => x.mission === ia), db = s.drones.find((x) => x.mission === ib);
  check('동시 고장 2건에 서로 다른 드론 출동', da && db && da !== db, `${da?.id} · ${db?.id}`);
  run(200, () => ia.status !== 'open' && ib.status !== 'open'); }
console.log('== 현장 이벤트');
const ev = s.injectFieldEvent('leak', -5, 6); run(1); s.detectFieldEvent(ev, 'AMR-03', 0.93);
let respAt = null; run(150, () => { if (ev.inc.steps.some((x) => x.text.includes('현장 도착 ·')) && respAt == null) respAt = s.time - ev.inc.t0; return ev.inc.status !== 'open'; });
check('현장 이벤트에 드론 먼저 도착·판단 보강', ev.inc.drone && (respAt == null || ev.inc.drone.dt <= respAt) && ev.inc.steps.some((x) => x.text.startsWith('판단 보강')), `드론 ${ev.inc.drone?.dt.toFixed(1)}초 · 대응 ${respAt?.toFixed(1) ?? '-'}초`);
console.log('== 우선순위');
const st2 = s.processing.find((x) => x.id === 'DT_FAST'); s.fail(st2); run(0.3);
const ev2 = s.injectFieldEvent('intrusion', 2, -6); s.detectFieldEvent(ev2, 'AMR-05', 0.9); run(0.3);
check('현장 이벤트에 드론 배정 (우선순위)', s.drones.some((x) => x.mission === ev2.inc), s.drones.map((x) => x.mission?.title ?? x.mode).join(' / '));
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
