// 배터리 로봇 검증 — AMR·휴머노이드·AMMR 배터리가 움직이면 줄고 충전 자리에서 차며, 3시간 동안 바닥나지 않는지
// (휴머노이드는 30% 아래면 배터리 팩 교체). 실행: npm test
import { zoneLine } from '../js/line.js';
import { Simulation, BATTERY } from '../js/sim.js';
import { FactoryAgent } from '../js/agent.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== 배터리 (피지컬AI 3시간)');
{ const s = new Simulation('dark', 2, { line: zoneLine(), quiet: true }); const ag = new FactoryAgent(s);
  const mn = {}, mx = {}, rec = (k, v) => { mn[k] = Math.min(mn[k] ?? 101, v); mx[k] = Math.max(mx[k] ?? -1, v); };
  let chgSeen = { carrier: false, humanoid: false, ammr: false }; const idleLow = new Map(); let idleLowMax = 0;
  for (let t = 0; t < 3 * 3600; t += 0.1) {
    s.step(0.1); ag.update(0.1);
    for (const c of s.carriers) { rec('AMR', c.battery); if (c.chgNow) chgSeen.carrier = true; }
    for (const h of [...s.helpers, ...s.techs]) { rec('휴머노이드', h.battery); if (h.chgNow) chgSeen.humanoid = true;
      // 할 일 없이 30% 아래로 서 있는 시간 (곧바로 팩 교체에 들어가야 한다)
      if (h.kind === 'humanoid' && h.idle && !h.swapping && h.battery < BATTERY.humanoid.low) { const v = (idleLow.get(h) ?? 0) + 0.1; idleLow.set(h, v); idleLowMax = Math.max(idleLowMax, v); } else idleLow.set(h, 0); }
    for (const st of s.processing) for (const u of st.ammr ?? []) { rec('AMMR', u.battery); if (u.chgNow) chgSeen.ammr = true; }
  }
  const r = (k) => `${Math.round(mn[k])}~${Math.round(mx[k])}%`;
  check('AMR 배터리가 저전압 아래로 떨어지지 않음 (정차 위치 기회 충전)', mn.AMR > BATTERY.carrier.low && chgSeen.carrier, r('AMR'));
  const swaps = [...s.helpers, ...s.techs].reduce((a, h) => a + (h.swaps ?? 0), 0);   // 물류·정비 휴머노이드 팩 교체
  check('휴머노이드 배터리가 바닥나지 않음 (저전압 전에 대기 충전, 30% 아래면 할 일을 마치는 대로 팩 교체)', mn['휴머노이드'] > 15 && idleLowMax < 60, `${r('휴머노이드')} · 교체 ${swaps}회 · 30% 아래 대기 최장 ${idleLowMax.toFixed(1)}초`);
  check('AMMR 배터리가 저전압 아래로 떨어지지 않음 (작업 위치 도킹 충전)', mn.AMMR > BATTERY.ammr.low && chgSeen.ammr, r('AMMR'));
  check('배터리 잔량이 움직임에 따라 변함 (고정값 아님)', mx.AMR - mn.AMR > 5 && mx.AMMR - mn.AMMR > 1, `AMR 폭 ${Math.round(mx.AMR - mn.AMR)}%`);
}
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
