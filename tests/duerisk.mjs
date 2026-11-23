// 납기 위험 판단이 가동 직후의 낮은 생산 속도에 속지 않는지 검증 (js/factoryos.js rateInfo).
// 고치기 전에는 시작 5분에 첫 오더가 「예상 완료 6시간 뒤」로 판정되어 납기가 361분 늦춰졌다(실제로는 몇 분 늦는 수준). 실행: npm test
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { zoneLine } from '../js/line.js';

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}`); ok ? pass++ : fail++; };

for (const mode of ['dark', 'smart']) {
  const s = new Simulation(mode, 12345, { quiet: true, line: zoneLine() }), ag = new FactoryAgent(s), F = s.fos;
  const o = () => F.orders.find((x) => x.id === 'ORD-001'), due0 = o().due;
  let tClose = null;
  for (let k = 0; k < 3 * 36000 && tClose == null; k++) { s.step(0.1); ag.update(0.1); if (o().status !== 'open') tClose = s.time; }
  const risk = F.bus.log.filter((m) => m.type === 'decision.request' || /납기 위험/.test(m.text ?? '')).find((m) => /ORD-001 납기 위험/.test(m.text ?? ''));
  const late = tClose - due0, ext = o().due - due0;
  check(`${mode}: 첫 오더가 3시간 안에 종료`, tClose != null, tClose ? `종료 ${(tClose / 60).toFixed(0)}분 · 처음 납기 ${(due0 / 60).toFixed(0)}분` : '');
  check(`${mode}: 납기 위험은 양품이 5개 이상 나온 뒤에 판단`, !risk || risk.t > 600, risk ? `판단 시각 ${Math.round(risk.t)}초` : '납기 위험 없음');
  check(`${mode}: 납기 조정 폭이 실제 지연과 같은 크기 (1시간 안쪽)`, ext <= 3600 && (late <= 0 || ext > 0), `실제 지연 ${(late / 60).toFixed(0)}분 · 납기 조정 ${(ext / 60).toFixed(0)}분`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
