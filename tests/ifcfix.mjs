// 형상 간섭 검사기가 드러낸 이동체 · 물류 · 레거시 단계 겹침 가운데 시뮬레이션 쪽 원인 검증 (화면 형상 쪽은 npm run check:interference)
//   ① 순찰 드론이 미니로드 자동창고 선반(꼭대기 5.76m) 위를 6.3m 이상으로 넘는다 ② 분기 벨트에서 다른 줄 대상물끼리 겹쳐 지나가지 않고, 레거시 컨베이어 셀은 앞 대상물이 0.45m 나간 뒤에 다음을 받는다
//   ③ 출하 지게차가 구분 적재장 팔레트 앞에 서는 자리 — 집어 든 팔레트가 남은 상자와 겹치지 않는 거리. 실행: npm test
import { Simulation, SINK_FORK_Z } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { zoneLine, pointAt } from '../js/line.js';
import { WH_RACK, MINILOAD } from '../js/receiving.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 드론 ↔ 미니로드 선반 상부');
{ const s = new Simulation('dark', 20261001, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); let over = 0, low = 0, minY = 99, maxY = 0;
  const top = MINILOAD.top + 0.06, belly = 0.3;   // 크라운 프레임 윗면 · 기체 중심 아래 짐벌 · 스키드
  for (let k = 0; k < 30 * 600; k++) { s.step(0.1); ag.update(0.1);
    for (const d of s.drones) { if (Math.abs(d.x - WH_RACK.x) < MINILOAD.half + 0.05 + 0.45 && Math.abs(d.z - WH_RACK.z) < 5.15 + 0.45) { over++; minY = Math.min(minY, d.y); if (d.y - belly < top + 0.1) low++; } maxY = Math.max(maxY, d.y); } }
  check('30분 순찰: 선반 위(기체 반폭 0.45m 포함)를 지나는 동안 기체 밑면이 선반 꼭대기보다 10cm 이상 높다', over > 100 && low === 0, `선반 위 ${over}틱 · 최저 고도 ${minY.toFixed(2)}m (선반 꼭대기 ${top.toFixed(2)}m) · 낮은 틱 ${low}`);
  check('천장 설비(7.2m) 아래 0.6m 이상 남는다', maxY <= 6.6, `최고 고도 ${maxY.toFixed(2)}m`); }
console.log('== 레거시 컨베이어: 셀 중앙에서 대상물끼리');
{ const s = new Simulation('traditional', 20261001, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s); let n = 0, bad = 0, minS = 99, forkMin = 99; const prev = new Map();
  for (let k = 0; k < 20 * 600; k++) { s.step(0.1); ag.update(0.1);
    for (const st of s.processing) { const it = st.item; if (it && prev.get(st) !== it) { n++;   // 방금 셀로 받음
        for (const c of Object.values(st.outs)) { const last = c.items[c.items.length - 1]; if (last) { minS = Math.min(minS, last.s); if (last.s < 0.45 - 1e-6) bad++; } } }
      prev.set(st, it); } 
    for (const st of s.stations) { const outs = Object.values(st.outs ?? {}); if (outs.length < 2) continue;   // 분기 벨트: 다른 줄 대상물끼리 직선 거리
      for (const c of outs) for (const o of outs) if (c.idx < o.idx) for (const e of c.items) for (const f of o.items) { if (e.s > 6 || f.s > 6) continue; const p = pointAt(c.path, e.s), q = pointAt(o.path, f.s); forkMin = Math.min(forkMin, Math.hypot(p.x - q.x, p.z - q.z)); } } }
  check('20분: 셀이 다음 대상물을 받을 때 앞서 나간 대상물은 셀 중앙에서 0.45m 이상 나가 있다', n > 50 && bad === 0, `받은 횟수 ${n} · 그때 앞 대상물 최소 ${minS === 99 ? '-' : minS.toFixed(2)}m · 위반 ${bad}`);
  check('20분: 분기 벨트(부품분류셀 출구)에서 다른 줄 대상물끼리 0.9m 이상 떨어져 있다 (겹쳐 지나가지 않음)', forkMin >= 0.9, `최소 ${forkMin.toFixed(2)}m`);
  check('20분: 레거시 생산이 이어진다', s.stats.good >= 15, `양품 ${s.stats.good}`); }
console.log('== 출하 지게차 ↔ 구분 적재장 팔레트');
check('팔레트 앞 정지 자리: 포크 위 적재 팔레트 앞끝(차체 앞 1.94m)이 남은 상자(가장자리 3.46m) 밖', SINK_FORK_Z - 1.94 >= 3.46 + 0.02, `정지 자리 ${SINK_FORK_Z}m → 적재 팔레트 앞끝 ${(SINK_FORK_Z - 1.94).toFixed(2)}m`);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
