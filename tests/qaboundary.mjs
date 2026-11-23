// 지시 경계 회귀 검사 (2026-10-28 Codex 검증 보고서 outputs/qa-2026-10-28) — 실행: npm test
// ① 하지 말라는 지시 · ② 묻는 말 · ③ 대상 셀이 불분명한 지시는 명령으로 실행하지 않는다 (내장 해석기 → 게이트 → 실행 후 상태 비교)
// ⑦ Agent 응답을 기다리는 동안 연달아 보낸 지시: 응답은 보낸 그 지시에 붙고, 가운데 지시도 빠지지 않는다 (외부 호출 없이 응답을 늦춰 흉내)
import { Simulation } from '../js/sim.js';
import { zoneLine } from '../js/line.js';
import { FactoryAgent } from '../js/agent.js';
import { parseInstruction, applyAction } from '../js/dialog.js';
import { evaluate } from '../js/gate.js';
import { LLMController } from '../js/llm.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

console.log('== 하지 말라는 지시 · 묻는 말 · 불분명한 대상은 실행하지 않음');
const run = (text, pre) => {
  const s = new Simulation('dark', 7, { line: zoneLine(), quiet: true }), agent = new FactoryAgent(s);
  if (pre) { s.cmd.issue(pre, 'all'); for (let i = 0; i < 30; i++) s.step(0.1); }
  const before = { estop: s.cmd.estopAll, evac: s.cmd.evac, hold: s.processing.filter((x) => x.cmd?.hold === 'cycle').length };
  const { actions } = parseInstruction(text, s), done = [];
  for (const a of actions) { const g = evaluate(a, s, agent); if (g.verdict === 'approve') done.push(applyAction(a, s, { agent })); }
  for (let i = 0; i < 100; i++) s.step(0.1);
  const after = { estop: s.cmd.estopAll, evac: s.cmd.evac, hold: s.processing.filter((x) => x.cmd?.hold === 'cycle').length };
  return { actions, done, before, after };
};
for (const [text, pre] of [['비상정지 하지 마'], ['비상정지 해제하지 마', 'ESTOP'], ['포장셀 속도 낮추지 마'], ['전체 대피 해제하지 마', 'EVACUATE'], ['DT_ASY 셀 정지'], ['조립셀 정지']]) {
  const r = run(text, pre);
  check(`${text} → 실행 없음 · 상태 그대로`, !r.done.length && JSON.stringify(r.before) === JSON.stringify(r.after), r.actions.map((a) => a.type + (a.reason ? ` (${a.reason})` : '')).join(' ; '));
}
for (const [text, target] of [['현재 비상정지 상태 알려줘', 'all'], ['포장셀 정비 상태 어때?', 'PACK']]) {
  const r = run(text);
  check(`${text} → 조회만`, r.actions.length === 1 && r.actions[0].type === 'status' && r.actions[0].target === target && JSON.stringify(r.before) === JSON.stringify(r.after));
}
// 고친 뒤에도 원래 되던 지시는 그대로
for (const [text, code, target] of [['비상정지 해제', 'RESET', 'all'], ['도어트림 조립셀 정지', 'CYCLE_STOP', 'DT_ASSY'], ['전체 사이클 정지', 'CYCLE_STOP', 'all'], ['포장셀 정비해줘', 'MAINT', 'PACK']]) {
  const r = parseInstruction(text, new Simulation('dark', 7, { line: zoneLine(), quiet: true }));
  check(`${text} → ${code} ${target}`, r.actions.length === 1 && r.actions[0].code === code && r.actions[0].target === target);
}

console.log('== Agent 응답 대기 중 연달아 보낸 지시');
const sim = new Simulation('dark', 7, { line: zoneLine(), quiet: true }), agent = new FactoryAgent(sim);
const ctl = new LLMController(); ctl.attach(sim, agent); ctl.setEnabled(true); ctl.available = true; ctl.snapshot = () => ({});
const pend = []; ctl.runTurn = (payload) => new Promise((resolve) => pend.push({ payload, resolve }));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const reply = (text, target, pct) => ({ text, actions: [{ name: 'issue_command', input: { code: 'SPEED', target, arg: pct, reason: text } }], rejected: [], costUSD: 0, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1 });
ctl.chat('첫번째 요청 alpha'); const first = ctl.dialogs[0];
ctl.chat('두번째 요청 beta'); const second = ctl.dialogs[0];
ctl.chat('세번째 요청 gamma'); const third = ctl.dialogs[0];
const waitN = async (n) => { for (let i = 0; i < 40 && pend.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };
pend[0].resolve(reply('alpha', 'PACK', 75)); await settle(); await waitN(2);
pend[1].resolve(reply('beta', 'DT_ASSY', 50)); await settle(); await waitN(3);
pend[2]?.resolve({ ...reply('gamma', 'SORT', 60), actions: [] }); await settle();
const tg = (d) => (d.agentItems ?? []).map((x) => x.action.target).join(',');
check('첫 응답은 첫 지시에', tg(first) === 'PACK' && first.items[0].gate.verdict !== 'pending', `첫 ${tg(first)} · 둘째 ${tg(second)}`);
check('둘째 응답은 둘째 지시에', tg(second) === 'DT_ASSY');
check('세 지시 모두 Agent에 전달 (가운데 빠짐 없음)', pend.map((p) => p.payload.operatorMessage).join(' | ') === '첫번째 요청 alpha | 두번째 요청 beta | 세번째 요청 gamma', pend.map((p) => p.payload.operatorMessage).join(' | '));
check('조치 없는 응답은 그 지시만 미반영', third.items[0].gate.verdict === 'reject' && !third.agentItems?.length);

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
