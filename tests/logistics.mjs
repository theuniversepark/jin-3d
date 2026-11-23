// 입고 물류 검증 — 입고 지게차 전용 영역에 다른 이동체가 들어오지 않는지, 입고 트럭 순환·반듯한 접안, 창고 재고 유지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, moverRadius, MINILOAD_OUTS } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { INBOUND, WH, WH_RACK, MINILOAD } from '../js/receiving.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const Z = INBOUND.zone;
for (const mode of ['traditional', 'smart', 'dark']) {
  console.log(`== ${mode}`);
  const s = new Simulation(mode, 2, { line: zoneLine(), quiet: true }); const ag = new FactoryAgent(s);
  s.whRaw = 110;   // 실제 작업 시간은 원자재 소비가 느리다 — 재주문점(80) 바로 위에서 시작해 2시간 안에 입고 순환을 본다
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
    const RK = { x0: WH_RACK.x - MINILOAD.half, x1: WH_RACK.x + MINILOAD.half, z0: WH_RACK.z - 5.1, z1: WH_RACK.z + 5.1 };   // 미니로드 ①·② 몸체(두 줄 선반, 왼쪽 벽 쪽 남북 방향)와 겹치지 않음
    if (rcv.x + 0.9 > RK.x0 && rcv.x - 0.9 < RK.x1 && rcv.z + 0.6 > RK.z0 && rcv.z - 0.6 < RK.z1) out++;   // 문 밖 적재함까지(1.2m)는 허용
    minRaw = Math.min(minRaw, s.whRaw);
    if (rcv.idle && Math.hypot(rcv.x - rcv.home.x, rcv.z - rcv.home.z) < 1e-3) { parked++; const e = Math.abs(((rcv.heading - INBOUND.park.heading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI); worst = Math.max(worst, e); if (e > 1e-3) crooked++; }
    const d = s.inbound.docked; if (d && !seen.has(d.id)) { seen.add(d.id); docks.push({ z: d.z, heading: d.heading }); }   // 접안한 순간의 위치·방향
  }
  check('입고 지게차 전용 영역에 다른 이동체 침입 없음', intr === 0, intr ? `${intr}회 · ${who}` : '');
  check('입고 지게차는 전용 영역 안에서만 작업', out === 0, out ? `${out}회` : '');
  check('입고 트럭 도착·하차·출차 순환 (실제 작업 시간 — 2시간에 1대 이상)', s.inbound.stats.trucks >= 1, `완료 ${s.inbound.stats.trucks}대`);
  check('접안 트럭이 도크 중심선에 반듯이 정렬', docks.length > 0 && docks.every((d) => Math.abs(d.z - INBOUND.dockZ) < 1e-6 && Math.abs(d.heading + Math.PI / 2) < 1e-6), `${docks.length}대`);
  check('입고 지게차가 대기 주차 칸에 반듯이 주차', parked > 0 && crooked === 0, `주차 ${(parked / 10).toFixed(0)}초 · 최대 어긋남 ${(worst * 180 / Math.PI).toFixed(1)}°`);
  check('창고 원자재가 바닥나지 않음 (소진 직전 재입고)', minRaw > 0 && minRaw <= WH.rawReorder, `최저 ${minRaw}박스`);
}
console.log('== 미니로드 몸체·출고 컨베이어와 이동체 간섭 (휴머노이드 몸통 · AGV · 작업자)');
{ // 선반 몸체(두 줄 4단 선반 ①·②)와 AGV 출고 신축 롤러(AGV가 섰을 때만 선반 면 밖으로 뻗음)를 바닥 상자로 보고, 이동체 원(몸 반경)이 들어가는지 0.1초마다 검사
  const face = WH_RACK.x + MINILOAD.half;
  const boxes = [{ name: '미니로드 몸체', x0: WH_RACK.x - MINILOAD.half, x1: face, z0: WH_RACK.z - 5.1, z1: WH_RACK.z + 5.1 },
    ...MINILOAD_OUTS.wh.filter((o) => o.end > face).map((o) => ({ name: `출고 컨베이어 z ${o.z.toFixed(1)}`, x0: face, x1: o.end, z0: o.z - 0.36, z1: o.z + 0.36, pick: o.pick }))];
  const hum = MINILOAD_OUTS.wh.filter((o) => !o.agv);
  check('휴머노이드 피킹 자리 컨베이어는 선반 면 안에서 끝남 (몸 앞 0.5m 이상 비움)', hum.every((o) => o.end <= face + 0.05 && o.pick.x - o.end >= 0.5), hum.map((o) => (o.pick.x - o.end).toFixed(2)).join(' · '));
  check('입출고 자리가 제 구간 안에 있다 (① 부품 = 북쪽 절반 · ② 원자재 = 남쪽 절반)', MINILOAD_OUTS.wh.every((o) => (o.keys[0] === 'parts' ? o.z < WH_RACK.z - 0.4 && o.z > WH_RACK.z - 5.1 + 0.4 : o.z > WH_RACK.z + 0.4 && o.z < WH_RACK.z + 5.1 - 0.4)));
  for (const mode of ['traditional', 'smart', 'dark']) {
    const s = new Simulation(mode, 3, { line: zoneLine(), quiet: true }); const ag = new FactoryAgent(s);
    let hit = 0, who = '', worst = 0;
    for (let t = 0; t < 2 * 3600; t += 0.1) {
      s.step(0.1); ag.update(0.1);
      for (const m of s.movers) {
        if (m.receiver) continue;
        const r = m.kind === 'agv' ? 0.55 : moverRadius(m);   // AGV는 차폭 반(0.55m) — 상차 자리에서 컨베이어 끝에 닿는 것은 정상 (롤러 이재)
        for (const b of boxes) {
          if (b.pick && !s.vehicles.some((v) => v.kind === 'agv' && Math.hypot(v.x - b.pick.x, v.z - b.pick.z) < 0.3)) continue;   // AGV 신축 롤러는 AGV가 자리 0.3m 안에 있을 때만 뻗어 있다 (factory.js animMiniload)
          const dx = Math.max(b.x0 - m.x, 0, m.x - b.x1), dz = Math.max(b.z0 - m.z, 0, m.z - b.z1), pen = r - Math.hypot(dx, dz);
          if (pen > 0.02 && !(b.pick && Math.hypot(m.x - b.pick.x, m.z - b.pick.z) < 0.05)) { hit++; worst = Math.max(worst, pen); who ||= `${m.id} ${b.name} (${m.x.toFixed(2)}, ${m.z.toFixed(2)}) ${m.task ?? ''}`; }
        }
      }
    }
    check(`${mode}: 이동체가 미니로드 선반·출고 컨베이어를 파고들지 않음 (2시간)`, hit === 0, hit ? `${hit}회 · 최대 ${worst.toFixed(2)}m · ${who}` : '');
  }
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
