// 혼합형 다중 에이전트 검증 — 반사 계층 + 정비·품질·흐름 에이전트(제안) + 메인 조정자(안전 우선 · 충돌 판정)가 단일 에이전트와 같은 일을 하고,
// 디지털트윈 비교(같은 시드·이벤트·고장)에서 생산이 나빠지지 않는지, 제안 → 실행 지연·충돌·보류를 세는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { HybridAgent, compareArchitectures } from '../js/multiagent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 혼합형 다중 에이전트');
{ const s = new Simulation('smart', 7, { line: zoneLine(), quiet: true }), ag = new HybridAgent(s);
  for (let t = 0; t < 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
  const H = ag.status();
  check('도메인 에이전트 3개(정비·품질·흐름)가 제안 → 메인이 승인', H.agents.length === 3 && H.proposed > 0 && H.approved > 0 && H.agents.some((a) => a.key === 'maint' && a.approved > 0), H.agents.map((a) => `${a.label} ${a.proposed}/${a.approved}`).join(' · '));
  check('메인 조정: 충돌 판정·보류 · 제안 → 실행 지연 기록', H.conflicts > 0 && H.deferred > 0 && H.avgLat >= 0 && H.latMax < 120, `충돌 ${H.conflicts} · 보류 ${H.deferred} · 평균 ${H.avgLat.toFixed(2)}초 · 최대 ${H.latMax.toFixed(0)}초`);
  check('반사 계층은 바로 실행 (자재 배차 · 충전)', ag.history.some((h) => /자재 보충 배차|충전 지시/.test(h.title)));
  check('정비 인력 수보다 많은 예지정비를 한꺼번에 걸지 않음', s.requests.filter((r) => r.kind === 'pm').length <= s.techs.length + 1); }
{ const s = new Simulation('smart', 9, { line: zoneLine(), quiet: true }), ag = new HybridAgent(s);
  for (let t = 0; t < 600; t += 0.1) { s.step(0.1); ag.update(0.1); }
  const ev = s.injectFieldEvent('smoke', 0, 8.2); s.detectFieldEvent(ev, '시험', 0.9);
  const st = s.processing.find((x) => !x.request && x.state !== 'DOWN'); st.health = 20;
  for (let t = 0; t < 3; t += 0.1) { s.step(0.1); ag.update(0.1); }
  check('안전 우선: P1(화재 의심) 대응 중 예지정비 제안 보류', s.orch.urgentOpen(1).length > 0 && st.request?.kind !== 'pm' && ag.queue.some((q) => q.kind === 'pm' && q.st === st), `${st.name} 건강도 20% · P1 ${s.orch.urgentOpen(1).length}건`); }
console.log('== 피지컬AI 기본 = 혼합형 · 사족보행 순찰 보고 → 정비·품질 에이전트 제안');
{ const { MODES } = await import('../js/sim.js');
  check('피지컬AI 공장 기본 에이전트 구조 = 혼합형 다중', MODES.dark.agentArch === 'hybrid' && !MODES.smart.agentArch);
  const s = new Simulation('dark', 5, { line: zoneLine(), quiet: true }), ag = new HybridAgent(s);
  for (let t = 0; t < 3600; t += 0.1) { s.step(0.1); ag.update(0.1); }
  const H = ag.status(), viaPatrol = ag.history.filter((h) => /순찰 보고 →/.test(h.dec ?? ''));
  check('순찰 보고가 제안으로 올라가 메인 조정자가 승인 · 실행', (H.reports ?? 0) > 0 && viaPatrol.length > 0 && s.stats.pm + s.stats.cal > 0, `순찰 보고 ${H.reports}건 · 승인 실행 ${viaPatrol.length}건 · 예지정비 ${s.stats.pm} · 재보정 ${s.stats.cal}`); }
console.log('== 디지털트윈 비교 (자동화 1시간 × 시드 3, 설비 고장 주입)');
const R = compareArchitectures({ mode: 'smart', line: zoneLine(), T: 3600, seeds: [7, 19, 31] });
check('같은 조건 비교: 혼합형 생산(UPH)이 단일보다 나빠지지 않음 (−1% 이내)', R.hybrid.uph >= R.single.uph * 0.99, `단일 ${R.single.uph.toFixed(1)} · 혼합형 ${R.hybrid.uph.toFixed(1)} UPH · OEE ${(R.single.oee * 100).toFixed(2)} → ${(R.hybrid.oee * 100).toFixed(2)}%`);
check('비교 지표 (판단 지연 · 충돌 · 되돌림)', R.single.avgLat === 0 && R.hybrid.avgLat > 0 && R.hybrid.conflicts > 0, `혼합형 평균 지연 ${R.hybrid.avgLat.toFixed(2)}초 · 충돌 ${R.hybrid.conflicts.toFixed(1)} · 되돌림 ${R.hybrid.reversals.toFixed(1)}`);
const D = compareArchitectures({ mode: 'dark', line: zoneLine(), T: 1800, seeds: [7] });
check('피지컬AI: 혼합형이 단일보다 나빠지지 않음 (순찰 보고도 메인 조정)', D.hybrid.uph >= D.single.uph * 0.99, `단일 ${D.single.uph.toFixed(1)} · 혼합형 ${D.hybrid.uph.toFixed(1)}`);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
