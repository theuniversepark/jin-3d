// 정비 도구 출동 검증 — 정비원·정비 휴머노이드가 상황에 맞는 도구를 정비실에서 챙겨 현장에 가고, 처리 후 정비실에 반납하는지
// 설비 고장(수리 공구) · 바닥 누유(누유 처리 키트) · 이물질(수거 도구) · 연기 의심(소화기 대기). 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, TOOL_KITS, toolSpot, SINK_PICK } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, sec, each) => { for (let t = 0; t < sec; t += 0.1) { s.step(0.1); ag.update(0.1); each?.(); } };
console.log('== 정비 도구 출동 (피지컬AI)');
check('도구 세트 6종 (수리 · 예지정비 · 보정 · 누유 · 이물질 · 소화기) · 보관대는 정비실 안', ['repair', 'pm', 'cal', 'leak', 'debris', 'smoke'].every((k) => TOOL_KITS[k]?.items) && Object.keys(TOOL_KITS).every((k) => { const p = toolSpot(k); return p.x > 10 && p.x < 18 && p.z > 14 && p.z < 16.8; }));
for (const [type, label] of [['leak', '바닥 누유'], ['debris', '바닥 이물질']]) {
  const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  run(s, ag, 120);
  const ev = s.injectFieldEvent(type, 4, 8.2);
  let atSiteTool = null, tookInRoom = false, who = null;
  run(s, ag, 240, () => { const h = s.techs.find((m) => m.tool === type); if (h) { who = h; if (Math.hypot(h.x - toolSpot(type).x, h.z - toolSpot(type).z) < 0.3) tookInRoom = true; if (Math.hypot(h.x - 4, h.z - 8.2) < 1.6) atSiteTool = h.tool; } });
  const e = s.fieldEvents.find((x) => x.id === ev?.id) ?? ev;
  check(`${label}: 정비실 휴머노이드가 정비실에서 ${TOOL_KITS[type].label} 챙김 → 현장 도착`, !!who && who.kind === 'humanoid' && tookInRoom && atSiteTool === type, who ? `${who.id}` : '출동 없음');
  check(`${label}: 처리 완료 후 도구 반납 (손에 든 도구 없음)`, !!e?.cleared && s.techs.every((m) => !m.tool || m.tool !== type), e?.cleared ? `해소 ${(e.tClear - e.t0).toFixed(0)}초` : '미해소');
  const inc = s.orch.incidents.find((i) => i.key === `ev:${e?.id}`);
  check(`${label}: 오케스트레이터 타임라인에 도구 챙김 기록`, !!inc?.steps.some((x) => x.text.includes(TOOL_KITS[type].label)));
}
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  run(s, ag, 60);
  const st = s.processing.find((x) => x.id === 'DT_ASSY'); s.injectFault(st);
  let took = null, onSite = false;
  run(s, ag, 300, () => { const t = s.techs.find((m) => m.tool === 'repair'); if (t) { took = t; if (st.techOnSite) onSite = true; } });
  check('설비 고장: 정비 휴머노이드가 수리 공구 세트를 챙겨 출동 · 수리', !!took && onSite, took?.id ?? '출동 없음');
  check('설비 고장: 수리 후 도구 반납', st.state !== 'DOWN' && s.techs.every((m) => m.tool !== 'repair'), st.state); }
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  run(s, ag, 30);
  const ev = s.injectFieldEvent('smoke', -6, -8.2);
  let fx = null; run(s, ag, 200, () => { fx ??= s.techs.find((m) => m.tool === 'smoke'); });
  check('연기 의심: 사족보행 열화상 점검 + 대기 중 정비 휴머노이드가 소화기 챙겨 현장 대기 · 반납', !!fx && s.techs.every((m) => m.tool !== 'smoke'), fx?.id ?? '대기 휴머노이드 없음'); }
{ const s = new Simulation('smart', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
  run(s, ag, 30); const st = s.processing.find((x) => x.id === 'EA_ASSY'); s.injectFault(st);
  let took = null; run(s, ag, 300, () => { took ??= s.techs.find((m) => m.tool === 'repair'); });
  check('자동화(정비원): 정비원도 수리 공구 세트를 챙겨 출동', !!took && took.kind === 'human', took?.id ?? '출동 없음'); }
console.log('== 구분 적재장 · 휴머노이드 충전 도크');
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s), sink = s.stations[s.stations.length - 1];
  let early = 0, picks = 0, seen = new Set(), dock = 0, dockOk = 0;
  let back = 0, rel = 0; const prev = new Map();
  run(s, ag, 1800, () => {
    const h = sink.in.items[0]?.item;
    // 박스를 집은 뒤 AMR: 가운데 정지 구간(적재장 중심)에서 진행 방향 그대로 출발 — 입구 쪽으로 되돌아가지 않음
    for (const c of s.carriers) { const p = prev.get(c); if (c.state === "return" && p && p.state !== "return") { rel++; if (c.x < sink.x - 0.05) back++; } if (c.state === 'return' && p?.state === 'return' && Math.hypot(c.x - sink.x, c.z - sink.z) < 3 && c.x < p.x - 1e-3) back++; prev.set(c, { state: c.state, x: c.x }); }
    if (h?.pickT != null && !seen.has(h.id)) { seen.add(h.id); picks++; if ((h.enterT ?? 0) < SINK_PICK.enter - 1e-6) early++; }
    for (const m of [...s.techs, ...s.helpers]) if (m.kind === 'humanoid' && m.idle && !m.moving && Math.hypot(m.x - m.home.x, m.z - m.home.z) < 0.3) { dock++; if (m.chgNow && Math.abs(m.heading - m.home.heading) < 1e-6) dockOk++; }
  });
  check('구분 적재장: AMR이 가운데 정지 구간까지 들어간 뒤에 적재 로봇이 집기 시작', picks > 20 && early === 0, `집기 ${picks}회 · 진입 전 집기 ${early}`);
  check('구분 적재장: 박스를 집은 뒤 AMR은 가운데 정지 구간에서 바로 앞으로 출발 (뒤로 갔다 다시 오지 않음)', rel > 20 && back === 0, `출발 ${rel}회 · 뒤로 ${back}`);
  check('대기 중인 휴머노이드는 충전 도크에서 충전하며 도크 방향(등을 대고 통로 쪽)으로 선다', dock > 0 && dockOk === dock, `${dockOk}/${dock}`); }
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
