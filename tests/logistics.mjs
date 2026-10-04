// 입고 물류 검증 — 입고 지게차 전용 영역에 다른 이동체가 들어오지 않는지, 입고 트럭 순환·반듯한 접안, 창고 재고 유지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, moverRadius } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { INBOUND, WH, WH_RACK } from '../js/receiving.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const Z = INBOUND.zone;
for (const mode of ['traditional', 'smart', 'dark']) {
  console.log(`== ${mode}`);
  const s = new Simulation(mode, 2, { line: zoneLine(), quiet: true }); const ag = new FactoryAgent(s);
  const rcv = s.forklifts.find((f) => f.receiver);
  let intr = 0, who = '', out = 0, minRaw = 1e9, docks = [], seen = new Set();
  let parked = 0, crooked = 0, worst = 0;
  for (let t = 0; t < 1.5 * 3600; t += 0.1) {
    s.step(0.1); ag.update(0.1);
    for (const m of s.movers) {
      if (m === rcv) continue;
      const r = moverRadius(m);
      if (m.x + r > Z.x0 && m.x - r < Z.x1 && m.z + r > Z.z0 && m.z - r < Z.z1) { intr++; who ||= `${m.id} ${m.task ?? ''}`; }
    }
    const r = moverRadius(rcv);
    if (rcv.x + r < Z.x0 - 1.2 || rcv.x - r > Z.x1 || rcv.z - r < Z.z0 || rcv.z + r > Z.z1) out++;
    const RK = { x0: WH_RACK.x - 1.1, x1: WH_RACK.x + 1.1, z0: WH_RACK.z - 5.2, z1: WH_RACK.z + 5.2 };   // 물류 선반 몸체(왼쪽 벽에 붙은 남북 방향)와 겹치지 않음
    if (rcv.x + 0.9 > RK.x0 && rcv.x - 0.9 < RK.x1 && rcv.z + 0.6 > RK.z0 && rcv.z - 0.6 < RK.z1) out++;   // 문 밖 적재함까지(1.2m)는 허용
    minRaw = Math.min(minRaw, s.whRaw);
    if (rcv.idle && Math.hypot(rcv.x - rcv.home.x, rcv.z - rcv.home.z) < 1e-3) { parked++; const e = Math.abs(((rcv.heading - INBOUND.park.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI); worst = Math.max(worst, e); if (e > 1e-3) crooked++; }
    const d = s.inbound.docked; if (d && !seen.has(d.id)) { seen.add(d.id); docks.push({ z: d.z, heading: d.heading }); }   // 접안한 순간의 위치·방향
  }
  check('입고 지게차 전용 영역에 다른 이동체 침입 없음', intr === 0, intr ? `${intr}회 · ${who}` : '');
  check('입고 지게차는 전용 영역 안에서만 작업', out === 0, out ? `${out}회` : '');
  check('입고 트럭 도착·하차·출차 순환', s.inbound.stats.trucks >= 2, `완료 ${s.inbound.stats.trucks}대`);
  check('접안 트럭이 도크 중심선에 반듯이 정렬', docks.length > 0 && docks.every((d) => Math.abs(d.z - INBOUND.dockZ) < 1e-6 && Math.abs(d.heading + Math.PI / 2) < 1e-6), `${docks.length}대`);
  check('입고 지게차가 대기 주차 칸에 반듯이 주차', parked > 0 && crooked === 0, `주차 ${(parked / 10).toFixed(0)}초 · 최대 어긋남 ${(worst * 180 / Math.PI).toFixed(1)}°`);
  check('창고 원자재가 바닥나지 않음 (소진 직전 재입고)', minRaw > 0 && minRaw <= WH.rawReorder, `최저 ${minRaw}박스`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
