// 8D 봉쇄 보류가 라인을 세우지 않는지 검증 — 봉쇄 때 공정 중이던 제품은 완성 뒤 재검으로 풀려야 한다 (js/capa.js recheck).
// 승인자가 없는 자동화 단계(정책 승인 대기가 끝나지 않음)에서 정밀조립 혼류 라인을 8시간 돌려, 봉쇄품이 구분 적재장에 쌓여 생산이 멈추지 않는지 본다. 실행: npm test
import { Simulation } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
import { zoneLine } from '../js/line.js';

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}`); ok ? pass++ : fail++; };

for (const seed of [12345, 3]) {   // 두 시드 모두 고치기 전에는 5~6시간째에 멈췄다 (e-axle 봉쇄품 20개 이상이 적재장을 채움)
  const s = new Simulation('smart', seed, { quiet: true, line: zoneLine() }), ag = new FactoryAgent(s);
  let last = 0, tLast = 0, heldMax = 0;
  for (let k = 0; k < 8 * 36000; k++) {
    s.step(0.1); ag.update(0.1);
    if (s.stats.good !== last) { last = s.stats.good; tLast = s.time; }
    if (k % 600 === 0) heldMax = Math.max(heldMax, s.serials.heldIn('doortrim') + s.serials.heldIn('eaxle'));
  }
  const waiting = s.capa.list.filter((c) => c.status === 'approval').length;
  check(`시드 ${seed}: 8시간 내내 생산이 이어짐`, s.time - tLast < 600, `마지막 양품 ${(tLast / 3600).toFixed(1)}시간 · 양품 ${last}개`);
  check(`시드 ${seed}: 승인 대기 8D가 있어도 적재장 봉쇄품이 쌓이지 않음`, waiting > 0 && heldMax <= 16, `승인 대기 8D ${waiting}건 · 적재장 보류 최대 ${heldMax}개`);
  check(`시드 ${seed}: 재검으로 풀린 기록이 8D에 남음`, s.capa.list.some((c) => c.steps?.some((x) => /뒤이어 완성된 제품/.test(x.text ?? ''))) || s.capa.list.every((c) => c.steps?.some((x) => /봉쇄 제품 재검 완료/.test(x.text ?? ''))));
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
