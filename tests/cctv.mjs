// CCTV 사각지대 검증 — 여러 라인 배치에서 바닥(1m 간격) 모든 지점이 최소 한 대에 보이는지(시야 가림 반영),
// 피지컬AI에서 어디서 난 현장 이벤트든 CCTV AI가 2초대에 감지하는지, CCTV 에이전트 이력이 오케스트레이터와 맞물리는지. 실행: npm test
import { zoneLine, DEFAULT_LINE } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { planCCTV, camerasSeeing } from '../js/cctv.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 사각지대');
for (const [nm, ln] of [['정밀조립Zone 1:1', zoneLine()], ['정밀조립Zone 2:1', zoneLine('2:1')], ['기본 라인', DEFAULT_LINE]]) {
  const s = new Simulation('dark', 1, { line: ln, quiet: true }), t0 = performance.now(), p = planCCTV(s), S = p.stats;
  check(`${nm}: 사각지대 0곳 (건물 안·입고·출하 야드)`, S.blind === 0 && S.coverage === 1, `CCTV ${p.cams.length}대 (안 ${S.inside} · 야드 ${S.outside}) · 지점 ${S.points} · 이중 감시 ${(S.redundancy * 100).toFixed(0)}% · ${Math.round(performance.now() - t0)}ms`);
}
console.log('== CCTV AI 감지 (피지컬AI)');
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }); for (let t = 0; t < 60; t += 0.1) s.step(0.1);
  let rng = 7; const rnd = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
  const evs = []; const P = s.cctv.regions.inside.pts;
  for (let k = 0; k < 20; k++) { const p = P[Math.floor(rnd() * P.length)]; evs.push(s.injectFieldEvent(['leak', 'debris', 'smoke', 'intrusion'][k % 4], p.x, p.z)); for (let t = 0; t < 3; t += 0.1) s.step(0.1); }
  const ok = evs.filter((e) => e.detected && e.tDetect - e.t0 <= 2.6);
  check('바닥 아무 곳 현장 이벤트 20건 모두 2.6초 안 감지', ok.length === evs.length, `${ok.length}/${evs.length} · ${[...new Set(evs.map((e) => e.detectedBy))].slice(0, 4).join(', ')}`);
  check('감지한 CCTV가 그 위치를 실제로 봄', evs.every((e) => !e.cctv || camerasSeeing(s.cctv, e.x, e.z).some((c) => c.id === e.cctv)));
}
{ const s = new Simulation('smart', 2, { line: zoneLine(), quiet: true }); const ev = s.injectFieldEvent('leak', 0, 9); for (let t = 0; t < 5; t += 0.1) s.step(0.1);
  check('자동화 단계는 녹화·관제만 (AI 자동 감지 없음)', !ev.detected); }
console.log('== CCTV 에이전트 이력 · 오케스트레이터 연동');
{ const s = new Simulation('dark', 3, { line: zoneLine(), quiet: true }); for (let t = 0; t < 60; t += 0.1) s.step(0.1);
  const A = s.cctvAgent, ev = s.injectFieldEvent('leak', -5, 8); for (let t = 0; t < 4; t += 0.1) s.step(0.1);
  const rep = A.history.find((h) => h.kind === 'report' && h.label === '바닥 누유');
  check('감지 → 이력 등록(보고) · 오케스트레이터 인시던트 연결', !!rep && !!rep.inc && ev.detected && /CCTV 에이전트/.test(ev.detectedBy), rep ? `${rep.no} ${rep.cam} ${rep.model} ${rep.conf} → #${rep.inc?.id}` : '');
  check('오케스트레이터 타임라인에 CCTV 보고 단계', !!rep?.inc?.steps?.some((st) => /CCTV 에이전트 보고/.test(st.text)));
  const st = s.stations.find((x) => x.type === 'fasten'); s.injectFault(st); for (let t = 0; t < 3; t += 0.1) s.step(0.1);
  check('설비 고장 인시던트 → 영상 기록 확보 이력', A.history.some((h) => h.kind === 'record'), A.history.map((h) => `${h.no}:${h.kind}`).join(' '));
  for (let t = 0; t < 600 && A.history.some((h) => h.status === 'open'); t += 0.1) s.step(0.1);
  check('인시던트 종료 시 이력도 종료(소요·결과 기록)', A.history.every((h) => h.status === 'closed' && h.dur > 0 && h.result), A.history.map((h) => `${h.no}:${h.status}:${h.dur?.toFixed(1)}s`).join(' '));
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
