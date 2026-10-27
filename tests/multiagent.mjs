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
  // 충돌·보류는 고장·정비 시점이 겹쳐야 생긴다 — 시드 하나는 셀 사이클(부품분류셀 키트 옮겨 싣기 등)에 따라 0일 수 있어 시드 2개(7 · 19)를 합쳐 보고,
  // 그래도 0이면 병목 셀이 가동 중일 때 정비 제안을 직접 넣어 충돌 판정·보류를 확인한다 (상위 meta-factory와 같은 방식)
  const s2 = new Simulation('smart', 19, { line: zoneLine(), quiet: true }), ag2 = new HybridAgent(s2);
  for (let t = 0; t < 3600; t += 0.1) { s2.step(0.1); ag2.update(0.1); }
  const H2 = ag2.status(), conf = H.conflicts + H2.conflicts, defer = H.deferred + H2.deferred;
  const m2 = s2.mode; let bott = null, bc = 0; for (const st of s2.processing) { const c = st.def.cycle * m2.cycleMul * st.speedMul * (st.def.share ?? 1); if (c > bc) { bc = c; bott = st; } }
  for (let i = 0; i < 3000 && (bott.state !== 'BUSY' || bott.request); i++) { s2.step(0.1); ag2.update(0.1); }
  const c0 = ag2.ma.conflicts, d0 = ag2.ma.deferred;
  ag2.queue.push({ kind: 'pm', st: bott, t0: s2.time, prio: 3, why: '시험: 병목 셀 가동 중 예지정비 제안' }); ag2.arbitrate();
  const forced = ag2.ma.conflicts > c0 && ag2.ma.deferred > d0;
  check('메인 조정: 충돌 판정·보류 · 제안 → 실행 지연 기록 (시드 2개 + 병목 가동 중 정비 제안)', (conf > 0 || forced) && (defer > 0 || forced) && H.avgLat >= 0 && Math.max(H.latMax, H2.latMax) < 120, `시드 충돌 ${conf} · 보류 ${defer} · 병목(${bott.name}) 가동 중 제안 → ${forced ? '충돌·보류' : '판정 안 됨'} · 평균 ${((H.avgLat + H2.avgLat) / 2).toFixed(2)}초 · 최대 ${Math.max(H.latMax, H2.latMax).toFixed(0)}초`);
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
console.log('== 디지털트윈 비교 (자동화 1시간 × 시드 40, 설비 고장 주입)');
// 시드마다 ±5~7% 흔들린다(어느 셀이 언제 고장 나는지) — 시드 20개 평균도 ±0.7% 흔들려 기준(−1%) 근처에서 오락가락하므로 시드 40개 평균으로 본다
const R = compareArchitectures({ mode: 'smart', line: zoneLine(), T: 3600, seeds: Array.from({ length: 40 }, (_, i) => 7 + i * 12) });
check('같은 조건 비교: 혼합형 생산(UPH)이 단일보다 나빠지지 않음 (−1% 이내)', R.hybrid.uph >= R.single.uph * 0.99, `단일 ${R.single.uph.toFixed(1)} · 혼합형 ${R.hybrid.uph.toFixed(1)} UPH · OEE ${(R.single.oee * 100).toFixed(2)} → ${(R.hybrid.oee * 100).toFixed(2)}%`);
check('비교 지표 (판단 지연 · 충돌 · 되돌림)', R.single.avgLat === 0 && R.hybrid.avgLat > 0 && R.hybrid.proposed > 0 && R.hybrid.conflicts >= 0, `혼합형 제안 ${R.hybrid.proposed} ·  평균 지연 ${R.hybrid.avgLat.toFixed(2)}초 · 충돌 ${R.hybrid.conflicts.toFixed(1)} · 되돌림 ${R.hybrid.reversals.toFixed(1)}`);
// 시드 1개는 배치·동선이 조금만 바뀌어도 ±5% 넘게 흔들려 비교가 안 된다 — 자동화 비교처럼 시드 3개 평균으로 본다
// 자재 투입 로봇셀(AGV 하역 위치 4.2 → 4.5m)로 시드 3개 평균이 −1.6%(같은 코드로 시드 12개는 +0.4%)까지 흔들려 시드 12개 평균으로 본다 (상위 meta-factory와 같은 방식)
const D = compareArchitectures({ mode: 'dark', line: zoneLine(), T: 1800, seeds: Array.from({ length: 12 }, (_, i) => 7 + i * 6) });
check('피지컬AI: 혼합형이 단일보다 나빠지지 않음 (순찰 보고도 메인 조정)', D.hybrid.uph >= D.single.uph * 0.99, `단일 ${D.single.uph.toFixed(1)} · 혼합형 ${D.hybrid.uph.toFixed(1)}`);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
