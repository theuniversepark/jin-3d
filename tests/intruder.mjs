// 사람 진입(안전구역 무단 진입) — 진입자가 통로를 따라 건물 앞 개방면(sim.js EXITS — 오른쪽 세로 통로 끝 · 물류 확장동 앞)으로 나가고, 가장 가까운 사족보행이 뒤에서 4m 거리를 두고 따라가며 행동 · 동선을 보고한다
//   ① 진입자가 나가면 이벤트가 닫힌다 ② 추적 로봇이 합류한다 ③ 합류 3초 뒤부터 거리 3.8m 이상 ④ 진입자 · 로봇이 셀 안을 지나가지 않는다
//   ⑤ 행동 · 동선 보고가 인시던트 흐름에 남는다 ⑥ 끝나면 로봇이 순찰 속도로 돌아간다
import { zoneLine } from '../js/line.js';
import { Simulation, EXITS } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
let rnd = 2468; const R = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const res = [];
for (let i = 0; i < 12; i++) {
  const s = new Simulation('dark', 1 + (i % 4), { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  const run = (sec, f) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); if (f?.()) return true; } };
  run(30 + R() * 150);
  let x, z, k = 0; do { x = -34 + R() * 68; z = -17 + R() * 34; k++; } while (k < 200 && s.stations.some((st) => Math.abs(x - st.x) < 3.2 && Math.abs(z - (st.z ?? 0)) < 3.2));
  const ev = s.injectFieldEvent('intrusion', x, z); s.detectFieldEvent(ev, 'test', 0.9);
  for (let k2 = 0; k2 < 300 && !ev.walk; k2++) run(0.1);
  const q = s.quads.find((m) => m.id === ev.responder), r = { i, q: !!q, gap: 99, cell: null };
  run(400, () => {
    for (const c of s.stations) {
      if (ev.walk?.phase === 'walk' && !ev.cleared && Math.abs(ev.x - c.x) < 2.2 && Math.abs(ev.z - (c.z ?? 0)) < 2.2) r.cell ??= `진입자 → ${c.id}`;
      if (q && ev.escort?.phase === 'follow' && !ev.cleared && Math.abs(q.x - c.x) < 2.2 && Math.abs(q.z - (c.z ?? 0)) < 2.2) r.cell ??= `로봇 → ${c.id}`;
    }
    if (q && ev.escort?.phase === 'follow' && !ev.cleared && s.time - ev.escort.tJoin > 3) r.gap = Math.min(r.gap, Math.hypot(q.x - ev.x, q.z - ev.z));
    return ev.cleared;
  });
  run(2);
  r.cleared = ev.cleared; r.joined = ev.escort?.phase === 'follow'; r.joinGap = ev.escort?.joinGap ?? null; r.reports = ev.inc.steps.filter((x) => x.kind === 'act' && x.text.includes('보고')).length;
  r.ended = !!ev.escort?.ended; r.cctv = ev.inc.steps.some((x) => x.text.includes('CCTV 추적으로 이탈 확인')); r.speed = q?.speed; r.left = ev.walk?.done;
  r.exit = EXITS.find((E) => Math.hypot(ev.x - E.x, ev.z - E.z) < 0.5)?.key ?? null; r.exitKey = ev.walk?.exit;
  // 현장 대응 팝업(추적 사족보행 창)이 읽는 값: 동선(trail) · 행동(acts) · 서버 전송(tx: ack · status · track · done) · 최소 거리
  const kinds = new Set((ev.tx ?? []).map((m) => m.kind)), stt = (ev.tx ?? []).filter((m) => m.kind === 'status' && m.role === 'escort').at(-1)?.body;
  r.state = ev.trail?.length > 5 && ev.acts?.length >= 3 && ['detect', 'ack', 'status', 'done'].every((k) => kinds.has(k)) && (!r.joined || (kinds.has('track') && ev.escort.minGap < 99 && stt?.keepGap === 4 && stt?.person?.exit === r.exit));
  res.push(r);
}
const n = res.length;
check('추적 로봇이 배정된다', res.every((r) => r.q), `${res.filter((r) => r.q).length}/${n}`);
check('진입자가 건물 앞 개방면으로 나가 이벤트가 닫힌다', res.every((r) => r.cleared && r.left), `${res.filter((r) => r.cleared && r.left).length}/${n}`);
check('추적 로봇이 합류해 따라간다 (출구 가까이 들어와 먼저 나간 경우 제외 — 2/3 이상)', res.filter((r) => r.joined).length >= n * 2 / 3, `${res.filter((r) => r.joined).length}/${n}`);
const jg = res.filter((r) => r.joined).map((r) => r.joinGap);
check('합류(현장 도착 · 포착)는 진입자 5.5m 안에서만 선언된다', jg.every((g) => g != null && g <= 5.5), `합류 거리 ${jg.map((g) => g?.toFixed(1)).join(' · ')}m`);
const mg = Math.min(...res.map((r) => r.gap));
check('합류 뒤 거리 3.8m 이상 유지', mg >= 3.8, `최소 ${mg.toFixed(2)}m`);
check('진입자 · 로봇이 셀 안을 지나가지 않는다', res.every((r) => !r.cell), res.find((r) => r.cell)?.cell ?? '');
check('합류한 건은 로봇의 행동 · 동선 보고가 인시던트 흐름에 남는다 (합류 · 보고 · 종료 3건 이상)', res.filter((r) => r.joined).every((r) => r.reports >= 3), `최소 ${Math.min(...res.filter((r) => r.joined).map((r) => r.reports))}건`);
check('합류 전에 나간 건은 CCTV로 이탈을 확인하고 합류를 취소한다', res.filter((r) => !r.joined).every((r) => r.cctv && r.ended), `${res.filter((r) => !r.joined).length}건`);
check('진입자가 나간 곳이 출구(EXITS)이고 고른 출구와 같다', res.every((r) => r.exit && r.exit === r.exitKey), [...new Set(res.map((r) => r.exit))].join(' · '));
check('팝업이 읽을 상태가 남는다 (동선 · 행동 · 서버 전송 detect · ack · status · track · done)', res.every((r) => r.state), `${res.filter((r) => r.state).length}/${n}`);
check('추적 종료 보고 · 순찰 속도 복귀', res.every((r) => r.ended && r.speed === 1.2), '');
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
