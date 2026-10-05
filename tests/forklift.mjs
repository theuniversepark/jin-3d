// 지게차 포크 간섭 검증 — 포크(차체 중심 앞 0.75~1.9m, 폭 ±0.42m)가 다른 이동체(로봇·AMR·사람)·셀 바닥·충전 기둥·정비실 비품과 겹치지 않는지.
// 3단계 공장(레거시·자동화·피지컬AI)을 각각 30분 돌리며 0.5초마다 포크 위 점들을 검사한다. 트럭 앞에서는 트럭 쪽을 본 채 들어가고 후진으로 나오는지도 본다. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, moverRadius, chgLoc, LOC, FORK } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const forkPts = (f) => { const d = { x: Math.sin(f.heading), z: Math.cos(f.heading) }, n = { x: d.z, z: -d.x }, out = [];
  for (let a = 0.75; a <= 1.9 + 1e-6; a += 0.23) for (const l of [-0.42, 0, 0.42]) out.push({ x: f.x + d.x * a + n.x * l, z: f.z + d.z * a + n.z * l }); return out; };
const fixed = [...[0, 1, 2, 3, 4, 5].map((i) => { const c = chgLoc(i); return { name: '충전 기둥', x0: c.x - 0.25, x1: c.x + 0.25, z0: c.z + 1.3, z1: c.z + 1.7 }; }),
  { name: '정비실 비품', x0: LOC.TECH.x - 1.7, x1: LOC.TECH.x + 5.9, z0: 15.9, z1: 16.8 }];
console.log('== 지게차 포크 간섭');
check('포크 크기 설정: 포크 끝 1.9m · 차체·포크 선분 앞 1.45m + 반폭 0.55m ≥ 1.9m', FORK.reach >= 1.9 && FORK.front + FORK.half >= 1.9);
for (const [mode, label] of [['traditional', '레거시'], ['smart', '자동화'], ['dark', '피지컬AI']]) {
  const s = new Simulation(mode, 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  const forks = [...s.forklifts, ...s.vehicles.filter((v) => v.kind === 'forklift')];
  const hit = { mover: [], cell: [], fixed: [] }; let backOut = 0, turnIn = 0;
  for (let t = 0; t < 1800; t += 0.1) {
    s.step(0.1); ag.update(0.1);
    if (Math.round(t * 10) % 5) continue;
    for (const f of forks) {
      const P = forkPts(f);
      // 트럭에서 나올 때: 출하 도크 벽(z −20)·입고 도크 벽(x −51) 2.2m 안(포크 끝이 적재함에 닿는 거리)에서 움직이는 지게차는 늘 트럭(벽) 쪽을 본다 — 포크를 넣은 채 후진, 돌지 않음
      const nearShip = f.z < -20 + 2.2 && f.shipper, nearIn = f.x < -51 + 2.3 && Math.abs(f.z + 14.5) < 1 && f.receiver;
      if (f.moving && (nearShip || nearIn)) { const faceWall = nearShip ? Math.cos(f.heading) < -0.95 : Math.sin(f.heading) < -0.95; faceWall ? backOut++ : turnIn++; }
      for (const o of s.movers) if (o !== f && o.state !== 'line' && P.some((p) => Math.hypot(p.x - o.x, p.z - o.z) < moverRadius(o) * 0.8)) hit.mover.push(`${f.id}→${o.id}`);
      for (const st of s.stations) { const d = st.def; if (d.x == null) continue; const h = st.type === 'source' || st.type === 'sink' ? [1.8, 2.3] : [2.3, 2.3], c = Math.cos(d.rot ?? 0), sn = Math.sin(d.rot ?? 0);
        if (P.some((p) => { const rx = p.x - d.x, rz = p.z - (d.z ?? 0); return Math.abs(rx * c - rz * sn) < h[0] && Math.abs(rx * sn + rz * c) < h[1]; })) hit.cell.push(`${f.id}→${st.name}`); }
      for (const o of fixed) if (P.some((p) => p.x > o.x0 && p.x < o.x1 && p.z > o.z0 && p.z < o.z1)) hit.fixed.push(`${f.id}→${o.name}`);
    }
  }
  const moved = forks.reduce((a, f) => a + f.dist, 0);
  check(`${label}: 포크가 다른 로봇·AMR·사람과 겹치지 않음 (30분, 지게차 ${forks.length}대 · 주행 ${moved.toFixed(0)}m)`, !hit.mover.length && moved > 50, hit.mover.slice(0, 3).join(', '));
  check(`${label}: 포크가 셀(로봇·설비)·충전 기둥·정비실 비품과 겹치지 않음`, !hit.cell.length && !hit.fixed.length, [...hit.cell, ...hit.fixed].slice(0, 3).join(', '));
  check(`${label}: 트럭 앞 2.2m 안에서는 트럭 쪽을 본 채 들어가고 후진으로 나온다 (적재함 안에서 돌지 않음)`, backOut > 0 && turnIn === 0, `트럭 쪽 ${backOut} · 돌아섬 ${turnIn}`);
  check(`${label}: 출하가 계속 진행됨 (교착 없음)`, (s.stats.shipped ?? 0) > 50, `출하 ${s.stats.shipped}`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
