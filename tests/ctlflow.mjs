// 제어 흐름 탭 검증 — 오케스트레이터가 단계마다 제어·이벤트·판단 흐름을 분류해 레인 사이 흐름(건수·지연)과
// 인시던트 종류별 단계 지연을 누적하는지, 계층 흐름도·공정 흐름도가 그 값으로 그려지는지. 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { flowClass } from '../js/orchestrator.js';
import { OrchView } from '../js/orchview.js';
import { STEP_FLOWS, stepFlowSvg } from '../js/stepflow.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const run = (s, ag, T) => { for (let t = 0; t < T; t += 0.1) { s.step(0.1); ag.update(0.1); } };
const stubEl = () => ({ addEventListener() {}, classList: { contains: () => true }, querySelector: () => null, querySelectorAll: () => [] });

for (const mode of ['smart', 'dark']) {
  console.log(`== 제어·이벤트 흐름 (${mode})`);
  const s = new Simulation(mode, 7, { line: zoneLine() }), ag = new FactoryAgent(s), o = s.orch;
  run(s, ag, 120);
  const st = s.processing.find((x) => !x.standby && x.state !== 'DOWN' && x.state !== 'MAINT');
  s.injectFault(st);
  s.cmd.issue('SAFE_SPEED', 'all', null, { by: '테스트' });
  run(s, ag, 20);
  s.cmd.issue('SAFE_SPEED_OFF', 'all', null, { by: '테스트' });
  run(s, ag, 400);

  const fl = Object.values(o.flows), sum = (f) => fl.filter(f).reduce((a, x) => a + x.n, 0);
  const steps = o.incidents.reduce((a, i) => a + i.steps.length, 0);
  check('모든 단계가 흐름 집계에 들어감', sum(() => true) >= steps, `집계 ${sum(() => true)} · 남은 인시던트 단계 ${steps}`);
  check('분류: 위로 올라가면 이벤트 · 아래로 내려가면 제어 · 같은 계층은 단계 종류', fl.every((x) => Object.keys(x.kinds).every((k) => flowClass(x.from, x.to, k) === x.cls)) && fl.every((x) => !(x.from === 'orch' && x.to === 'cell') || x.cls === 'control'));
  check('제어 흐름: 오케스트레이터 → 셀 컨트롤러 명령', sum((x) => x.from === 'orch' && x.to === 'cell' && x.cls === 'control') > 0);
  check('이벤트 흐름: 셀 컨트롤러 → 오케스트레이터 보고·통보', sum((x) => x.from === 'cell' && x.to === 'orch' && x.cls === 'event') > 0);
  check('이벤트 흐름: 현장 감지 → 셀 컨트롤러', sum((x) => x.from === 'field' && x.to === 'cell') > 0);
  const fx = o.flows['field>cell>control'] ?? o.flows['cell>orch>event'];
  check('흐름 지연은 0 이상', fl.every((x) => x.dt >= 0) && !!fx, fx ? `평균 ${(fx.dt / fx.n).toFixed(2)}초` : '');
  const E = o.stages.equipment, C = o.stages.command;
  check('설비 고장 단계 지연 집계 (감지 → 판단 → 명령 → 완료 순서)', !!E && E.n >= 1 && E.at.decide / E.hit.decide <= E.at.command / E.hit.command && E.at.command / E.hit.command <= E.at.done / E.hit.done,
    E ? `판단 ${(E.at.decide / E.hit.decide).toFixed(1)}s · 명령 ${(E.at.command / E.hit.command).toFixed(1)}s · 완료 ${(E.at.done / E.hit.done).toFixed(1)}s` : '없음');
  check('상위 명령 단계 지연 집계', !!C && C.n >= 2, C ? `${C.n}건` : '없음');
  check('흐름 기록: 최신순 · 분류 포함', o.journal.length > 0 && o.journal.every((j, i) => i === 0 || j.t <= o.journal[i - 1].t) && o.journal.every((j) => j.cls === flowClass(j.from, j.to, j.kind)));

  const v = new OrchView(stubEl(), {}); v.sim = s;
  const L = v.layerSvg(), P = v.procSvg();
  check('계층 흐름도: 오케스트레이터·셀·현장 노드와 제어·이벤트 선', /존 오케스트레이터/.test(L) && /셀 컨트롤러/.test(L) && /현장 감지/.test(L) && /ca-control/.test(L) && /ca-event/.test(L));
  check(`계층 흐름도: FAC 노드 ${s.fac.on ? '표시' : '없음'}`, /FAC \(FACOS 업무 기록\)/.test(L) === !!s.fac.on);
  v.flt = 'event';
  check('필터(이벤트): 제어 선을 흐리게', /class="ce dim/.test(v.layerSvg()));
  const shown = s.stations.filter((x) => P.includes(x.name.slice(0, 4))).length;
  check('공정 흐름도: 투입 → 셀 → 적재 상자', P.includes('투입 ') && P.includes('적재 ') && shown >= s.processing.filter((x) => !x.standby).length, `${shown}개 표시`);
}

console.log('== 공정별 제어 흐름도 (STEP 1~6 · 4레인)');
{
  const bad = STEP_FLOWS.flatMap((st) => st.links.filter(([a, b]) => !st.box[a] || !st.box[b]).map(([a, b]) => `STEP${st.no} ${a}>${b}`));
  check('모든 연결선의 양 끝 상자가 있음', !bad.length, bad.join(', '));
  const lanes = STEP_FLOWS.every((st) => Object.keys(st.box).every((id) => 'AOCF'.includes(id[0])));
  check('상자는 4레인(오케스트레이터 · 셀 컨트롤러 · 현장 제어 · 설비·로봇·AMR)에만', lanes);
  check('STEP마다 제어(c)·이벤트(e) 연결 포함', STEP_FLOWS.every((st) => st.links.some((l) => l[2] === 'c') && st.links.some((l) => l[2] === 'e')));
  for (const mode of ['traditional', 'smart', 'dark']) {
    const s = new Simulation(mode, 5, { line: zoneLine(), quiet: true }), ag = new FactoryAgent(s);
    run(s, ag, 200);
    const ok = STEP_FLOWS.every((st) => { const v = stepFlowSvg(st, s); return v.startsWith('<svg') && v.includes(`STEP ${st.no}`); });
    check(`${mode}: 6개 STEP 흐름도 그림`, ok);
    if (mode !== 'dark') continue;
    const st = s.stations.find((x) => x.id === 'DT_ASSY');
    s.injectFault(st); run(s, ag, 1);
    const v3 = stepFlowSvg(STEP_FLOWS[2], s);
    check('조립셀 고장 → STEP3 결품·고장 대응 예외 상자 강조', /class="sf-b exc on"><title>[^<]*결품·고장 대응 모드/.test(v3) && /class="sf-b exc on"><title>[^<]*휴머노이드 출동/.test(v3));
    const f = s.stations.find((x) => x.id === 'DT_FAST');
    stepFlowSvg(STEP_FLOWS[3], s); f.c.defects++;
    const v4 = stepFlowSvg(STEP_FLOWS[3], s);
    check('체결셀 불량 발생 → STEP4 불량 분기 강조·건수', /class="sf-b exc on"><title>[^<]*불량: 원인 공정 추적/.test(v4) && />불량 \d+</.test(v4));
    const v4e = stepFlowSvg(STEP_FLOWS[3], s, 'event');
    check('필터(이벤트): 제어 연결선을 흐리게', /sf-ln k-control dim/.test(v4e) && !/sf-ln k-event dim/.test(v4e));
  }
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
