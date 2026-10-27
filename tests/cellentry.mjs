// AMR 셀 진입 — 셀에 작업 중인 AMR이 있으면 다음 AMR은 셀 밖(셀 바닥 판 바깥 대기 지점)에서 기다렸다가 셀이 비면 들어가는지,
// 포장셀 합류 두 줄이 입구 게이트 기둥(x −2.05, z ±1.0) 사이 가운데로 지나가는지. 자동화·피지컬AI 30분 × 시드 2. 실행: npm test
import { zoneLine, toWorld, AMR_CELL } from '../js/line.js';
import { Simulation } from '../js/sim.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== AMR 셀 진입 (셀 밖 대기 · 포장셀 게이트)');
const HALF_L = 0.74, HALF_W = 0.475, PLATE = 2.3, GATE = { x: -2.05, post: 1.0 - 0.07 };   // AMR 반길이·반폭 · 셀 바닥 판 반길이 · 게이트 기둥 안쪽 면
for (const mode of ['smart', 'dark']) {
  let intrude = 0, intrudeEx = '', two = 0, gateHit = 0, gateEx = '', waited = 0, entered = 0;
  for (const seed of [2, 5]) {
    const s = new Simulation(mode, seed, { line: zoneLine(), quiet: true });
    const loc = (st, c) => { const o = toWorld(st.def, 0, 0), d = toWorld(st.def, 1, 0), ux = d.x - o.x, uz = d.z - o.z; return { lx: (c.x - o.x) * ux + (c.z - o.z) * uz, lz: (c.x - o.x) * uz - (c.z - o.z) * ux }; };
    const prev = new Map();
    for (let t = 0; t < 1800; t += 0.1) {
      s.step(0.1);
      for (const st of s.processing) {
        // 셀로 들어오는 경로 위 AMR(아직 셀이 받지 않음): 차체가 셀 바닥 판과 겹치지 않음
        for (const cv of st.ins) for (const e of cv.items) { const c = e.item.carrier; if (!c) continue; const p = loc(st, c);
          if (p.lx + HALF_L > -PLATE + 1e-3 && Math.abs(p.lz) < PLATE + HALF_W) { intrude++; intrudeEx ||= `${st.name} ${c.id} (${p.lx.toFixed(2)}, ${p.lz.toFixed(2)})`; }
          if (e.s >= cv.len - 1e-6 && st.item?.carrier) waited++; }
        // 셀 안 AMR은 한 대
        if (s.carriers.filter((c) => c.lineInfo?.where === 'cell' && c.lineInfo.station === st.id && c.state === 'line').length > 1) two++;
        // 포장셀 게이트: 차체가 게이트 면을 지나는 동안 기둥 안쪽(차체 옆면 |lz| + 반폭 < 기둥 안쪽 면)
        if (st.id === 'PACK' && st.item?.carrier) { const p = loc(st, st.item.carrier);
          if (Math.abs(p.lx - GATE.x) < HALF_L && Math.abs(p.lz) + HALF_W > GATE.post) { gateHit++; gateEx ||= `(${p.lx.toFixed(2)}, ${p.lz.toFixed(2)})`; } }
        if (st.item && prev.get(st) !== st.item) entered++;
        prev.set(st, st.item);
      }
    }
  }
  const label = mode === 'smart' ? '자동화' : '피지컬AI';
  check(`${label}: 셀로 들어오는 AMR이 셀 바닥 판(±${PLATE}m) 밖에서 대기 (대기 지점 셀 중앙 앞 ${AMR_CELL.wait}m)`, intrude === 0, intrude ? `${intrude}회 · 예 ${intrudeEx}` : `셀 작업 중 대기 ${(waited / 10).toFixed(0)}초 · 진입 ${entered}회`);
  check(`${label}: 셀 안 AMR은 한 대`, two === 0, two ? `${two}회` : '');
  check(`${label}: 포장셀 합류 AMR이 입구 게이트 기둥 사이 가운데로 지남`, gateHit === 0, gateHit ? `${gateHit}회 · 예 ${gateEx}` : '');
  check(`${label}: 셀이 작업 중일 때 실제로 셀 밖에서 기다린 경우가 있음 (검사가 비어 있지 않음)`, waited > 0 && entered > 20);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
