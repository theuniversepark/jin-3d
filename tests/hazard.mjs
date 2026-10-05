// 진로 위 현장 이벤트 검증 — 이동 로봇·운반 AMR 진로에 해결 안 된 현장 이벤트가 있으면 우회하거나 해결될 때까지 정지 대기하고,
// 처음 마주친 로봇이 오케스트레이터 인시던트에 보고하는지. 대응 로봇은 현장으로 가고, 해결되면 대기하던 로봇이 이동을 재개한다. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, FIELD_EVENTS, moverRadius } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 진로 위 현장 이벤트 (피지컬AI)');
check('이벤트별 위험 반경 (누유·이물질·연기·무단 진입)', Object.values(FIELD_EVENTS).every((E) => E.radius > 0.5));
let reports = 0, waits = 0, detours = 0, inside = 0, resumed = 0, slow = 0, incOk = 0, n = 0, shipped = 0, responderReach = 0;
for (const seed of [2, 5]) {
  const s = new Simulation('dark', seed, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  const evs = []; let next = 300;
  for (let t = 0; t < 7200; t += 0.1) {
    s.step(0.1); ag.update(0.1);
    // 통로 위(운반 AMR·휴머노이드·사족보행·AGV가 다니는 곳)에 10분마다 현장 이벤트
    if (t > next) { next += 600; const k = Math.floor(t / 600); const p = [[4, 8.2], [-6, -8.2], [14, 8.4], [-20, 8.6], [22, -8.4]][k % 5]; evs.push(s.injectFieldEvent(['leak', 'debris', 'smoke'][k % 3], p[0], p[1])); }
    // 대응하지 않는 이동 로봇은 해결 전 이벤트 반경 안으로 들어가지 않는다 (바로 옆에서 발생하면 3초 안에 반경 밖으로 빠져나온다)
    if (Math.round(t * 10) % 5 === 0) for (const ev of s.fieldEvents ?? []) { if (ev.cleared || s.time - ev.t0 < 3) continue; const R = FIELD_EVENTS[ev.type].radius;
      for (const m of s.movers) { if (m.state === 'line' || ev.responder === m.id || m.tool || m.scanning || (m.steps[0]?.go && Math.hypot(m.steps[0].go.x - ev.x, m.steps[0].go.z - ev.z) < R + 2.5)) continue;
        if (Math.hypot(m.x - ev.x, m.z - ev.z) < R - 0.3) inside++; } }
  }
  for (const ev of evs) { n++; const a = ev.affected ? [...ev.affected.values()] : []; waits += a.filter((v) => v === 'wait').length; detours += a.filter((v) => v === 'detour').length;
    if (a.length) { reports++; const inc = ev.inc; if (inc?.steps.some((x) => x.lane === 'field' && /진로에 .* (우회|정지 대기)/.test(x.text))) incOk++; }
    if (!ev.cleared || ev.tClear - ev.t0 > 150) slow++; }
  resumed += s.stats.hazardResumes ?? 0; shipped += s.stats.shipped;
}
check('진로 이벤트를 마주친 로봇이 정지 대기 또는 우회', waits + detours > 0, `정지 대기 ${waits}대 · 우회 ${detours}대 (이벤트 ${n}건 중 ${reports}건)`);
check('처음 마주친 로봇이 오케스트레이터 인시던트에 "진로에 ○○ — 우회/정지 대기" 보고', reports > 0 && incOk === reports, `${incOk}/${reports}건`);
check('대응하지 않는 이동 로봇이 해결 전 이벤트 반경 안으로 들어가지 않음', inside === 0, `${inside}회`);
check('이벤트가 해결되면 대기하던 로봇이 이동 재개', resumed > 0, `재개 ${resumed}회`);
check('모든 이벤트가 150초 안에 해결 (대기 로봇이 대응을 막지 않음)', slow === 0, `늦음 ${slow}건`);
check('생산·출하가 계속됨', shipped > 1000, `2시간 × 2 출하 ${shipped}`);
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
