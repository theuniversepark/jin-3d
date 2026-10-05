// 이동체 경로·막힘 검증 — 모든 이동 로봇(AMR·AGV·지게차·정비원/정비 휴머노이드·물류 휴머노이드·사족보행·작업자)이
// 할 일이 있는데 오래 제자리에 갇히지 않는지. 3단계 공장 × 시드 2개 × 2시간, 설비 고장(6분마다)·현장 이벤트(피지컬AI 10분마다) 주입. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, toolSpot, moverRadius } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 이동 로봇 막힘 (할 일이 있는데 제자리)');
const LIMIT = 12;   // 초 — 순환 대기·비켜서기가 이 안에 풀려야 한다
for (const [mode, label] of [['traditional', '레거시'], ['smart', '자동화'], ['dark', '피지컬AI']]) {
  let worst = { d: 0, who: '' }, roomWait = 0, dockHits = [], circle = 0; const nearT = new Map();
  for (const seed of [2, 5]) {
    const s = new Simulation(mode, seed, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), st = new Map();
    const docks = s.movers.filter((m) => m.kind === 'humanoid' && m.home?.heading != null);
    // 충전 도크(바닥 판 ±0.475 · 뒤 기둥 −0.34~−0.52)와 겹침 — 도크 주인은 자기 도크 기둥만 검사
    const onDock = (m, d) => { const H = d.home, c = Math.cos(H.heading), sn = Math.sin(H.heading), rx = m.x - H.x, rz = m.z - H.z, lx = rx * c - rz * sn, lz = rx * sn + rz * c, r = moverRadius(m) * 0.7;
      if (Math.abs(lx) < 0.25 + r && lz < -0.34 + r && lz > -0.52 - r) return true; return m !== d && Math.abs(lx) < 0.475 + r && lz < 0.475 + r && lz > -0.52 - r; };
    let nextEv = 300;
    for (let t = 0; t < 2 * 3600; t += 0.1) {
      s.step(0.1); ag.update(0.1);
      if (mode === 'dark' && t > nextEv) { nextEv += 600; const k = Math.floor(t / 600); const p = [[4, 8.2], [-6, -8.2], [14, 8.4], [-20, 8.6], [22, -8.4]][k % 5]; s.injectFieldEvent(['leak', 'debris', 'smoke'][k % 3], p[0], p[1]); }
      if (Math.round(t * 10) % 3600 === 1800) { const c = s.processing[Math.floor(t / 360) % s.processing.length]; if (c.state !== 'DOWN') s.injectFault(c); }
      if (Math.round(t * 10) % 3 === 0) for (const d of docks) for (const m of s.movers) if (m.state !== 'line' && onDock(m, d)) dockHits.push(`${m.id}→${d.id} 도크`);
      // 충전 도크 복귀: 도크 3.5m 안에서 들어가지 못하고 맴도는 시간 (곧게 들어가면 5초 안팎)
      for (const h of [...s.helpers, ...s.techs]) { const g = h.steps.length === 1 && h.steps[0].go, d = Math.hypot(h.x - h.home.x, h.z - h.home.z);
        if (h.kind === 'humanoid' && g && Math.hypot(g.x - h.home.x, g.z - h.home.z) < 0.05 && d < 3.5 && d > 0.3) { const v = (nearT.get(h) ?? 0) + 0.1; nearT.set(h, v); circle = Math.max(circle, v); } else nearT.set(h, 0); }
      for (const m of s.movers) {
        if (m.state === 'line' || m.charging) continue;
        const r = st.get(m);
        if (!(m.steps[0]?.go && m.path?.length) || m.hzWait || !r || Math.hypot(m.x - r.x, m.z - r.z) > 0.05) { st.set(m, { x: m.x, z: m.z, t0: t }); continue; }   // 진로 이벤트로 정지 대기 중인 것은 의도된 대기 (tests/hazard.mjs)
        const d = t - r.t0; if (d > worst.d) worst = { d, who: `${m.id} [${m.task}] ← ${m.blockedOn?.id ?? '?'}` };
        // 정비실 안(대기 자리·도구 보관대)에서 정비원·정비 휴머노이드끼리 막힌 시간
        if (s.techs.includes(m) && m.z > 13 && m.z < 16.9 && m.x > 10 && m.x < 18 && s.techs.includes(m.blockedOn) && d > 3) roomWait = Math.max(roomWait, d);
      }
    }
  }
  check(`${label}: 할 일이 있는 이동 로봇이 ${LIMIT}초 넘게 갇히지 않음 (2시간 × 시드 2)`, worst.d <= LIMIT, `최장 ${worst.d.toFixed(1)}초${worst.who ? ' · ' + worst.who : ''}`);
  check(`${label}: 정비실 안에서 정비원·정비 휴머노이드가 대기 중인 동료에게 막히지 않음 (3초 이하)`, roomWait === 0, roomWait ? `${roomWait.toFixed(1)}초` : '');
  check(`${label}: 이동 로봇이 휴머노이드 충전 도크(바닥 판·충전 기둥)와 겹치지 않음`, !dockHits.length, dockHits.slice(0, 3).join(', '));
  check(`${label}: 휴머노이드가 충전 도크 근처에서 맴돌지 않고 곧게 복귀 (도크 3.5m 안 8초 이하)`, circle <= 8, `최장 ${circle.toFixed(1)}초`);
}
check('정비 휴머노이드 충전 스테이션: 정비실 양쪽 끝에 하나씩 서로 마주 봄', (() => { const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }); const [a, b] = s.techs.map((t) => t.home); return a && b && Math.abs(a.x - b.x) > 5.5 && Math.abs(Math.sin(a.heading) + Math.sin(b.heading)) < 1e-6 && Math.sin(a.heading) * (b.x - a.x) > 0; })());
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
